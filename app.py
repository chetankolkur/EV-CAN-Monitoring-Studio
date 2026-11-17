from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="EV CAN Browser Monitor")

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "Frontend"

# Confidential BMS DBC file
DBC_API_URL = "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/documents?path=version1&file=bms.dbc"

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

dbc_text = None


def load_dbc():
    """Download the BMS DBC text using the AWS API."""
    global dbc_text

    response = requests.get(DBC_API_URL, timeout=20)
    response.raise_for_status()
    files = response.json().get("files", [])
    if not files or not files[0].get("url"):
        raise ValueError("The API response does not contain a DBC download URL")

    dbc_response = requests.get(files[0]["url"], timeout=30)
    dbc_response.raise_for_status()
    dbc_text = dbc_response.content.decode("utf-8-sig")


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
    if dbc_text is None:
        try:
            load_dbc()
        except Exception as error:
            raise HTTPException(
                status_code=503,
                detail=f"Could not load DBC: {type(error).__name__}"
            )
    return PlainTextResponse(dbc_text, headers={"Cache-Control": "no-store"})
