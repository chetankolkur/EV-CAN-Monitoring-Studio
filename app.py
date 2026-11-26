import json
import logging
import os
import re
import secrets
import smtplib
import time
from datetime import datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import boto3
from dotenv import load_dotenv
from botocore.exceptions import BotoCoreError, ClientError

load_dotenv()

import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger("e3-diagnostic-software")
logging.basicConfig(level=logging.INFO)

# Keys pulled from AWS Secrets Manager JSON into os.environ (if not already set).
SECRET_ENV_KEYS = (
    "SOFTWARE_VERSIONS_API_KEY",
    "SOFTWARE_VERSIONS_BEARER_TOKEN",
    "DOCUMENTS_API_URL",
    "SOFTWARE_VERSIONS_API_URL",
)


def load_secrets_from_aws() -> None:
    """
    Load secrets from AWS Secrets Manager when SECRETS_MANAGER_SECRET_NAME is set.
    Soft-skips when unset so local .env still works.
    """
    secret_id = (
        os.environ.get("SECRETS_MANAGER_SECRET_NAME")
        or os.environ.get("SECRET_NAME")
        or ""
    ).strip()
    if not secret_id:
        logger.info("SECRETS_MANAGER_SECRET_NAME not set — using env/.env only")
        return

    region = os.environ.get("AWS_REGION", "ap-south-1")
    max_attempts = 6
    delay_s = 5

    client = boto3.client("secretsmanager", region_name=region)
    last_error = None

    for attempt in range(1, max_attempts + 1):
        try:
            resp = client.get_secret_value(SecretId=secret_id)
            raw = resp.get("SecretString") or ""
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("Secret JSON must be an object")

            applied = []
            for key in SECRET_ENV_KEYS:
                value = data.get(key)
                if value is None or str(value) == "":
                    continue
                if not os.environ.get(key):
                    os.environ[key] = str(value)
                    applied.append(key)

            logger.info(
                "Loaded secrets from AWS Secrets Manager: %s keys=%s",
                secret_id,
                applied,
            )
            return
        except (BotoCoreError, ClientError, ValueError, json.JSONDecodeError) as error:
            last_error = error
            logger.error(
                "Failed to load secrets from Secrets Manager (%s) attempt %s/%s: %s",
                secret_id,
                attempt,
                max_attempts,
                error,
            )
            if attempt < max_attempts:
                logger.info(
                    "Retrying Secrets Manager in %ss (Pod Identity warmup)...",
                    delay_s,
                )
                time.sleep(delay_s)

    logger.error("Giving up loading secrets from %s: %s", secret_id, last_error)


load_secrets_from_aws()

app = FastAPI(title="EV CAN Browser Monitor")

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "Frontend"
DYNAMODB_REGION = os.getenv("AWS_REGION", "ap-south-1")
EMPLOYEE_TABLE_NAME = os.getenv("DYNAMODB_EMPLOYEE_TABLE", "diagnostic_software")
dynamodb = boto3.resource(
    "dynamodb",
    region_name=DYNAMODB_REGION,
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
)
employee_table = dynamodb.Table(EMPLOYEE_TABLE_NAME)
otp_table = dynamodb.Table(os.getenv("DYNAMODB_OTP_TABLE", "diagnostic_login_otp"))
try:
    OTP_PK = otp_table.key_schema[0]["AttributeName"]
except (
    BotoCoreError,
    ClientError,
    AttributeError,
    IndexError,
    KeyError,
    TypeError,
) as error:
    logger.warning(
        "Could not load OTP table key schema; defaulting to employee_id: %s",
        error,
    )
    OTP_PK = "employee_id"
INDIA_TIMEZONE = ZoneInfo("Asia/Kolkata")
DOCUMENTS_API_URL = os.environ.get(
    "DOCUMENTS_API_URL",
    "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/documents",
)
SOFTWARE_VERSIONS_API_URL = os.environ.get(
    "SOFTWARE_VERSIONS_API_URL",
    "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/software-versions",
)
DBC_ECU_BY_FILENAME = {
    "bms.dbc": "BMS",
    "mcu.dbc": "MCU",
    "tcu.dbc": "TCU",
    "middleware.dbc": "MiddleWare",
}

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


def _employee_contact(item, *fields):
    for field in fields:
        value = item.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _mask_email(email):
    if not email:
        return ""

    local, separator, domain = email.partition("@")
    if not separator:
        return "***"

    domain_name, dot, suffix = domain.partition(".")
    masked_domain = f"{domain_name[:1]}***"
    if dot:
        masked_domain = f"{masked_domain}.{suffix}"
    return f"{local[:1]}***@{masked_domain}"


def _mask_phone(phone):
    if not phone:
        return ""

    digits = re.sub(r"\D", "", phone)
    if not digits:
        return ""
    return f"***{digits[-4:]}"


def send_otp_email(to_email: str, employee_name: str, otp_code: str) -> None:
    smtp_host = os.getenv("SMTP_HOST", "email-smtp.ap-south-1.amazonaws.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_username = os.getenv("SMTP_USERNAME")
    smtp_password = os.getenv("SMTP_PASSWORD")
    from_email = os.getenv("SMTP_FROM_EMAIL")
    if not smtp_username or not smtp_password or not from_email:
        raise ValueError(
            "SMTP_USERNAME, SMTP_PASSWORD, and SMTP_FROM_EMAIL must be configured."
        )

    message = EmailMessage()
    message["Subject"] = "Your E3 ELECTRIC.AI verification code"
    message["From"] = from_email
    message["To"] = to_email
    greeting = f"Hello {employee_name}," if employee_name else "Hello,"
    message.set_content(
        f"{greeting}\n\nYour verification code is {otp_code}. "
        "Please use it to complete your sign-in."
    )

    with smtplib.SMTP(smtp_host, smtp_port) as server:
        server.starttls()
        server.login(smtp_username, smtp_password)
        server.send_message(message)


def _get_employee_item(emp_id):
    try:
        return employee_table.get_item(Key={"employee_id": emp_id}).get("Item")
    except (BotoCoreError, ClientError) as error:
        logger.exception("DynamoDB employee lookup failed")
        raise HTTPException(
            status_code=503,
            detail="Employee directory is temporarily unavailable.",
        ) from error


@app.post("/api/auth/send-otp")
def send_otp(payload: dict):
    emp_id = payload.get("employeeId")
    if not isinstance(emp_id, str) or not emp_id.strip():
        raise HTTPException(status_code=400, detail="A non-empty employeeId is required.")
    emp_id = emp_id.strip()

    employee = _get_employee_item(emp_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employee ID not found.")

    recipient_email = employee.get("email")
    if not isinstance(recipient_email, str) or not recipient_email.strip():
        raise HTTPException(
            status_code=422,
            detail="No email address is associated with this employee.",
        )
    recipient_email = recipient_email.strip()

    try:
        otp_item = otp_table.get_item(Key={OTP_PK: emp_id}).get("Item")
    except (BotoCoreError, ClientError) as error:
        logger.exception("DynamoDB OTP lookup failed")
        raise HTTPException(
            status_code=503,
            detail="Could not retrieve the verification code. Please try again.",
        ) from error

    now_epoch = int(time.time())
    reused = False
    if otp_item is not None:
        try:
            expireat = int(
                otp_item.get("expireat") or otp_item.get("ttl_epoch") or 0
            )
            is_active = now_epoch < expireat
        except (TypeError, ValueError) as error:
            logger.exception("DynamoDB OTP record is invalid")
            raise HTTPException(
                status_code=503,
                detail="The stored verification code is invalid. Please try again.",
            ) from error

        if is_active:
            otp_code = otp_item.get("otp")
            if not isinstance(otp_code, str):
                raise HTTPException(
                    status_code=503,
                    detail="The stored verification code is invalid. Please try again.",
                )
            reused = True
        else:
            try:
                otp_table.delete_item(Key={OTP_PK: emp_id})
            except (BotoCoreError, ClientError) as error:
                logger.exception("Expired DynamoDB OTP deletion failed")
                raise HTTPException(
                    status_code=503,
                    detail="Could not refresh the verification code. Please try again.",
                ) from error
            otp_item = None

    if reused:
        return {
            "ok": True,
            "reused": True,
            "name": employee.get("name"),
            "maskedEmail": _mask_email(recipient_email),
            "expiresAtIst": otp_item.get("expires_at_ist"),
        }

    if otp_item is None:
        otp_code = f"{secrets.randbelow(1_000_000):06d}"
        now_ist = datetime.now(INDIA_TIMEZONE)
        expiry_ist = now_ist + timedelta(hours=8)
        expireat = int(expiry_ist.timestamp())
        expires_at_ist = f"{expiry_ist.strftime('%Y-%m-%d %H:%M:%S')} IST"
        otp_item = {
            "employee_id": emp_id,
            "email": recipient_email,
            "otp": otp_code,
            "created_at_ist": f"{now_ist.strftime('%Y-%m-%d %H:%M:%S')} IST",
            "expires_at_ist": expires_at_ist,
            "expireat": expireat,
            "status": "PENDING",
        }
        if OTP_PK != "employee_id":
            otp_item[OTP_PK] = emp_id
        try:
            otp_table.put_item(Item=otp_item)
        except (BotoCoreError, ClientError) as error:
            logger.exception("DynamoDB OTP creation failed")
            raise HTTPException(
                status_code=503,
                detail="Could not create a verification code. Please try again.",
            ) from error

    try:
        send_otp_email(recipient_email, employee.get("name", ""), otp_code)
    except (OSError, smtplib.SMTPException, ValueError) as error:
        logger.exception("OTP email delivery failed")
        raise HTTPException(
            status_code=502,
            detail="Could not send the verification code. Please try again.",
        ) from error

    return {
        "ok": True,
        "reused": False,
        "name": employee.get("name"),
        "maskedEmail": _mask_email(recipient_email),
        "expiresAtIst": expires_at_ist,
    }


@app.post("/api/auth/verify-otp")
def verify_otp(payload: dict):
    emp_id = payload.get("employeeId")
    otp_code = payload.get("otp")
    if not isinstance(emp_id, str) or not emp_id.strip():
        raise HTTPException(status_code=400, detail="A non-empty employeeId is required.")
    emp_id = emp_id.strip()

    try:
        otp_item = otp_table.get_item(Key={OTP_PK: emp_id}).get("Item")
    except (BotoCoreError, ClientError) as error:
        logger.exception("DynamoDB OTP lookup failed during verification")
        raise HTTPException(
            status_code=503,
            detail="Could not retrieve the verification code. Please try again.",
        ) from error

    if otp_item is None:
        raise HTTPException(
            status_code=401,
            detail="No active OTP found. Please request a new code.",
        )

    try:
        expireat = int(
            otp_item.get("expireat") or otp_item.get("ttl_epoch") or 0
        )
    except (TypeError, ValueError) as error:
        logger.exception("DynamoDB OTP record is invalid")
        raise HTTPException(
            status_code=503,
            detail="The stored verification code is invalid. Please request a new code.",
        ) from error

    if int(time.time()) >= expireat:
        try:
            otp_table.delete_item(Key={OTP_PK: emp_id})
        except (BotoCoreError, ClientError) as error:
            logger.exception("Expired DynamoDB OTP deletion failed")
            raise HTTPException(
                status_code=503,
                detail="Could not clean up the expired verification code.",
            ) from error
        raise HTTPException(
            status_code=401,
            detail="OTP expired after 8 hours. Please request a new OTP.",
        )

    if not isinstance(otp_code, str) or otp_code != otp_item.get("otp"):
        raise HTTPException(status_code=401, detail="Invalid 6-digit OTP.")

    employee = _get_employee_item(emp_id)
    if employee is None:
        raise HTTPException(status_code=401, detail="Employee ID not found.")

    try:
        otp_table.update_item(
            Key={OTP_PK: emp_id},
            UpdateExpression="SET #status = :status",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":status": "VERIFIED"},
        )
    except (BotoCoreError, ClientError) as error:
        logger.exception("DynamoDB OTP verification update failed")
        raise HTTPException(
            status_code=503,
            detail="Could not verify the code. Please try again.",
        ) from error

    # TODO (Cloud Team): Add AI risk assessment & JWT
    return {
        "ok": True,
        "employee_id": emp_id,
        "name": employee.get("name"),
    }


def documents_api_payload(path=None):
    params = {"path": path} if path is not None else None
    response = requests.get(DOCUMENTS_API_URL, params=params, timeout=20)
    response.raise_for_status()
    try:
        payload = response.json()
    except ValueError as error:
        raise ValueError("The documents API returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise ValueError("The documents API response must be a JSON object")
    return payload


def validated_dbc_text(filename, content):
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError(f"{filename} is not valid UTF-8 text") from error
    has_message = re.search(
        r"(?m)^\s*BO_\s+\d+\s+\w+\s*:\s*\d+\s+\w+", text
    )
    has_signal = re.search(
        r"(?m)^\s*SG_\s+\w+\s*(?:M|m\d+M?)?\s*:\s*\d+\|\d+@[01][+-]", text
    )
    if not text.strip() or not has_message or not has_signal:
        raise ValueError(f"The download is not a valid {filename}")
    return text


def available_dbc_versions():
    payload = documents_api_payload()
    folders = payload.get("folders")
    if not isinstance(folders, list):
        raise ValueError("The documents API response does not contain a folders list")

    versions = []
    seen_paths = set()
    for folder in folders:
        if not isinstance(folder, dict):
            continue
        name = folder.get("name")
        path = folder.get("path") or name
        if not isinstance(name, str) or not isinstance(path, str):
            continue
        if not re.fullmatch(r"[A-Za-z0-9_-]+", path) or path in seen_paths:
            continue
        versions.append({"name": name, "path": path})
        seen_paths.add(path)
    return versions


def load_dbc_version(path):
    if not isinstance(path, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", path):
        raise ValueError("Invalid DBC version path")

    payload = documents_api_payload(path)
    files = payload.get("files")
    if not isinstance(files, list):
        raise ValueError("The version API response does not contain a files list")

    downloaded = []
    errors = []
    seen_ecus = set()
    for entry in files:
        if not isinstance(entry, dict):
            continue
        filename = entry.get("name")
        if not isinstance(filename, str) or not filename.lower().endswith(".dbc"):
            continue

        ecu = DBC_ECU_BY_FILENAME.get(filename.lower())
        url = entry.get("url")
        if not isinstance(url, str) or not url:
            errors.append({"ecu": ecu, "name": filename, "error": "No download URL provided"})
            continue
        try:
            parsed_url = urlsplit(url)
        except ValueError:
            errors.append({"ecu": ecu, "name": filename, "error": "Invalid download URL"})
            continue
        if parsed_url.scheme != "https" or not parsed_url.netloc:
            errors.append({"ecu": ecu, "name": filename, "error": "Invalid download URL"})
            continue
        if ecu and ecu in seen_ecus:
            errors.append({"ecu": ecu, "name": filename, "error": "Multiple DBC files map to this ECU"})
            continue
        if ecu:
            seen_ecus.add(ecu)

        try:
            response = requests.get(url, timeout=30)
            response.raise_for_status()
            text = validated_dbc_text(filename, response.content)
        except (requests.RequestException, ValueError) as error:
            errors.append({"ecu": ecu, "name": filename, "error": str(error)})
            continue

        downloaded.append({"ecu": ecu, "name": filename, "text": text})

    return {"version": path, "files": downloaded, "errors": errors}


@app.get("/")
def home():
    """Dashboard that reads the CAN adapter in Chrome via WebUSB/Web Serial."""
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/login")
def login():
    return FileResponse(FRONTEND_DIR / "login.html")


@app.get("/vehicle-verification")
def vehicle_verification():
    return FileResponse(FRONTEND_DIR / "vehicle-verification.html")


@app.get("/dashboard")
def dashboard():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/api/v1/health")
def health():
    return {"status": "ok"}


@app.get("/browser-can")
def browser_can():
    return RedirectResponse("/")


@app.get("/api/dbc-versions")
def get_dbc_versions():
    try:
        return {"versions": available_dbc_versions()}
    except requests.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=f"Could not fetch DBC versions: {type(error).__name__}"
        ) from error
    except ValueError as error:
        raise HTTPException(
            status_code=502,
            detail=f"Could not read DBC versions: {error}"
        ) from error


@app.get("/api/dbc-files")
def get_dbc_files(path: str):
    try:
        return load_dbc_version(path)
    except ValueError as error:
        raise HTTPException(
            status_code=400 if str(error) == "Invalid DBC version path" else 502,
            detail=f"Could not load DBC version: {error}"
        ) from error
    except requests.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=f"Could not fetch DBC version: {type(error).__name__}"
        ) from error


@app.post("/api/software-versions")
def get_software_versions(payload: dict):
    vin = payload.get("vin")
    variant = payload.get("variant")
    if not isinstance(vin, str) or not vin.strip():
        raise HTTPException(status_code=400, detail="A non-empty VIN is required")
    if not isinstance(variant, str) or variant not in {"C1", "C1x", "C2"}:
        raise HTTPException(status_code=400, detail="Variant must be C1, C1x, or C2")

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    api_key = os.environ.get("SOFTWARE_VERSIONS_API_KEY")
    if api_key:
        headers["x-api-key"] = api_key
    bearer_token = os.getenv("SOFTWARE_VERSIONS_BEARER_TOKEN")
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"

    try:
        response = requests.post(
            SOFTWARE_VERSIONS_API_URL,
            json={"vin": vin, "variant": variant},
            headers=headers,
            timeout=20,
            allow_redirects=False,
        )
        return Response(
            content=response.content,
            status_code=response.status_code,
            media_type=response.headers.get("content-type", "application/json"),
        )
    except requests.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=f"Could not fetch software versions: {type(error).__name__}"
        ) from error
