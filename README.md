# BasicRMM

A self-hosted remote monitoring and management (RMM) platform.

This repo contains the server, web dashboard, and agent for managing a fleet of Windows/Linux/macOS endpoints.

## Quick start

```bash
cp .env.example .env   # edit as needed
docker compose up -d
```

Open http://localhost:8000 and log in with the default admin account:

- Username: `admin`
- Password: `admin`

## Structure

- `server/` — FastAPI backend + web dashboard + Docker image
- `agent/` — Python agent installed on endpoints
- `docker-compose.yml` — runs the server with persistent SQLite data

## Adding an agent

From the Dashboard, copy the PowerShell install command and run it as Administrator on a target Windows machine. On Linux/macOS, use `agent/install.sh`.

## Security notes

Change `SECRET_KEY` and `AGENT_TOKEN` from their defaults before exposing this to the internet. This prototype uses SQLite; switch to PostgreSQL for production deployments.
