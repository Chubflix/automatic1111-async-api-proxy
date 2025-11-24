#!/usr/bin/env bash
set -euo pipefail

# One-line installer for automatic-async-proxy (API + worker via Docker Compose)
# - Downloads a GHCR-based docker-compose.yml
# - Ensures ./data directory exists for SQLite persistence
# - Copies .env.example to .env if not present
# - Prints next steps

REPO_RAW_BASE="https://raw.githubusercontent.com/chubflix/sd-async-api-proxy/main"

echo "==> Downloading docker-compose.yml (GHCR image)"
curl -fsSL "$REPO_RAW_BASE/deploy/docker-compose.ghcr.yml" -o docker-compose.yml

echo "==> Creating data directory (for SQLite persistence)"
mkdir -p data

if [ ! -f .env ]; then
  echo "==> Creating .env from example"
  curl -fsSL "$REPO_RAW_BASE/.env.example" -o .env
else
  echo "==> .env already exists; leaving it unchanged"
fi

cat << 'EOM'

Installation complete.

Next steps:
  1) Open the .env file and set at least AUTH_TOKEN (and optionally AUTOMATIC1111_API_BASE, PORT, etc.).
  2) Start the stack in the background:
       docker compose up -d
  3) Open Swagger UI:
       http://localhost:${PORT:-3000}/doc
  4) Health check:
       http://localhost:${PORT:-3000}/health

Note:
  - The ./data folder is mounted into the containers at /data and will persist your SQLite database (DB_PATH=/data/jobs.db).
  - The worker service is included and will process queued jobs when AUTOMATIC1111_API_BASE is configured.
EOM
