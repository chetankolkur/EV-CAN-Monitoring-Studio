# EV CAN Monitoring Studio (Browser mode)

Chrome / Edge dashboard that reads CAN over WebUSB (PCAN-USB) or Web Serial (SLCAN). No PCAN Gateway app required.

## Setup

```powershell
cd EV-CAN-Dashboard
python -m pip install -r requirements.txt
python -m uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000

## First-time PCAN-USB on Windows

1. Download Zadig: https://zadig.akeo.ie/
2. Plug in PCAN-USB
3. Zadig → Options → List All Devices → select PCAN-USB → WinUSB → Replace Driver
4. Re-plug adapter, click Connect in the dashboard

## Files

- `app.py` — FastAPI server + DBC proxy
- `Frontend/` — dashboard UI (WebUSB / Web Serial)
