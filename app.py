import re
from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="EV CAN Browser Monitor")

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "Frontend"

DBC_API_URLS = {
    "BMS": "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/documents?path=version1&file=bms.dbc",
    "MCU": "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/documents?path=version1&file=mcu.dbc",
    "TCU": "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/documents?path=version1&file=tcu.dbc",
    "MiddleWare": "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/documents?path=version1&file=MiddleWare.dbc",
}
DBC_FILENAMES = {
    "BMS": "bms.dbc",
    "MCU": "mcu.dbc",
    "TCU": "tcu.dbc",
    "MiddleWare": "MiddleWare.dbc",
}

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

dbc_text = None


def load_dbc_file(ecu):
    """Fetch a fresh DBC download URL and retrieve its validated contents."""
    global dbc_text
    api_url = DBC_API_URLS[ecu]
    response = requests.get(api_url, timeout=20)
    response.raise_for_status()
    payload = response.json()
    files = payload.get("files", []) if isinstance(payload, dict) else []
    filename = DBC_FILENAMES[ecu]
    entry = next(
        (
            item for item in files
            if isinstance(item, dict)
            and item.get("name") == filename
            and item.get("url")
        ),
        None,
    ) if isinstance(files, list) else None
    if not entry:
        raise ValueError(f"The API response does not contain {filename}")

    dbc_response = requests.get(entry["url"], timeout=30)
    dbc_response.raise_for_status()
    try:
        text = dbc_response.content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError(f"{filename} is not valid UTF-8 text") from error
    has_message = re.search(
        r"(?m)^\s*BO_\s+\d+\s+\w+\s*:\s*\d+\s+\w+", text
    )
    has_signal = re.search(
        r"(?m)^\s*SG_\s+\w+\s*(?:M|m\d+M?)?\s*:\s*\d+\|\d+@[01][+-]", text
    )
    if not text.strip() or not has_message or not has_signal:
        raise ValueError(f"The download is not a valid {filename} DBC file")
    if ecu == "BMS":
        dbc_text = text
    return text


def load_dbc():
    """Keep the original BMS loader available for existing callers."""
    return load_dbc_file("BMS")


@app.get("/")
def home():
    """Dashboard that reads the CAN adapter in Chrome via WebUSB/Web Serial."""
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/browser-can")
def browser_can():
    return RedirectResponse("/")


@app.get("/api/dbc-file")
def get_dbc_file():
    """Serve the BMS DBC text; the browser cannot call the AWS API directly (CORS)."""
    return get_dbc_file_for_ecu("BMS")


@app.get("/api/dbc-file/{ecu}")
def get_dbc_file_for_ecu(ecu: str):
    """Serve one of the configured ECU DBC files without exposing AWS CORS details."""
    if ecu not in DBC_API_URLS:
        raise HTTPException(status_code=404, detail="Unknown ECU DBC")
    try:
        text = load_dbc_file(ecu)
    except ValueError as error:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load {ecu} DBC: {error}"
        )
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load {ecu} DBC: {type(error).__name__}"
        )
    return PlainTextResponse(text, headers={"Cache-Control": "no-store"})
