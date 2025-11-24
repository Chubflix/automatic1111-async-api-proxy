Async Automatic1111 API Wrapper (automatic-async-proxy)

This project provides an async, bearer-protected API that queues txt2img/img2img jobs for Automatic1111, persists them in SQLite, serves Swagger UI, and runs a background worker that talks to a real Automatic1111 instance.

Quick install (Docker Compose, GHCR images)
- This single-line installer will:
  - Download a ready-to-run docker-compose.yml that uses the published GHCR image.
  - Create a local ./data folder for persistent SQLite storage.
  - Copy .env.example to .env if not present.
  - Print short next-step instructions.

Run this command in an empty folder where you want to deploy the stack:

/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Chubflix/automatic1111-async-api-proxy/refs/heads/main/scripts/install.sh)"

What happens next
- Edit the generated .env and set at least AUTH_TOKEN (and AUTOMATIC1111_API_BASE if you’ll run the worker).
- Start the stack:
  - docker compose up -d
- Open the docs/UI:
  - http://localhost:${PORT:-3000}/doc
- Health check:
  - http://localhost:${PORT:-3000}/health

Notes
- The ./data folder is mounted into containers at /data and will persist your SQLite DB (DB_PATH=/data/jobs.db).
- The worker service is part of the compose file and will process jobs if AUTOMATIC1111_API_BASE is configured (e.g., http://host.docker.internal:7860).
- For manual deployment or development details, see docs/deployment.md.