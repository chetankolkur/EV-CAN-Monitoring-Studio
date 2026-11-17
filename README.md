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

## Dashboard capabilities

The dark E3 ELECTRIC.AI diagnostic interface uses the existing FastAPI dashboard and DBC routes. Live CAN frames are received and decoded in the browser through PCAN-USB (WebUSB) or SLCAN (Web Serial); decoded signals can be recorded and exported as CSV. The optional simulator generates synthetic frames for interface testing only.

The current backend does not provide vehicle identity, DTC history, ECU test, repair workflow, firmware update, or parts-catalogue APIs. Those screens are marked unavailable and do not display sample vehicle data or simulated diagnostic results.
