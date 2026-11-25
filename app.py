import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from dotenv import load_dotenv
load_dotenv()

import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="EV CAN Browser Monitor")

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "Frontend"
DOCUMENTS_API_URL = "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/documents"
SOFTWARE_VERSIONS_API_URL = "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/software-versions"
DBC_ECU_BY_FILENAME = {
    "bms.dbc": "BMS",
    "mcu.dbc": "MCU",
    "tcu.dbc": "TCU",
    "middleware.dbc": "MiddleWare",
}

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

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
