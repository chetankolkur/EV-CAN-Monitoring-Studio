# E3 Diagnostic Software (FastAPI + browser CAN UI) — EKS image
# Build: docker build -t e3-diagnostic-software .
# Run:   docker run --rm -p 8000:8000 e3-diagnostic-software

FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -u 101 -r -s /usr/sbin/nologin appuser

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY Frontend ./Frontend

RUN chown -R 101:101 /app

USER 101

ENV PORT=8000 \
    APP_PORT=8000 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/v1/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
