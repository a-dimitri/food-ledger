# UI service image for Cloud Run.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# One image serves either service; APP_MODULE selects which (UI by default,
# mcp_server.app:app for the MCP service).
COPY core/ ./core/
COPY ui/ ./ui/
COPY mcp_server/ ./mcp_server/

# Cloud Run injects PORT (default 8080); bind to it on all interfaces.
ENV PORT=8080 APP_MODULE=ui.app:app
CMD ["sh", "-c", "exec python -m uvicorn ${APP_MODULE} --host 0.0.0.0 --port ${PORT}"]
