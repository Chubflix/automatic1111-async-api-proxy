Deployment and local serving of automatic-async-proxy (Express API + Swagger UI)

Overview
This repository now includes a minimal Express implementation of the async API wrapper (automatic-async-proxy). It serves:
- The documented API endpoints under /sdapi/v1/* (bearer-protected)
- Swagger UI at /doc
- Static schemas at /schemas for $ref resolution
- Health check at /health

Option A: Run the Express app locally (Yarn)
- Requirements: Node.js >= 18
- Environment:
  - AUTH_TOKEN must be set; all protected endpoints require Bearer AUTH_TOKEN.
  - Optional: PORT (default 3000)
- Steps:
  1) Install dependencies:
     - yarn install
  2) Start the server:
     - AUTH_TOKEN=your-secure-api-token PORT=3000 yarn start
  3) Open the docs:
     - http://localhost:3000/doc
  Notes:
  - The app serves /schemas so $refs resolve (e.g., automatic1111.spec.json).
  - The API now persists jobs in SQLite at DB_PATH (default /data/jobs.db when using Docker/Compose).

Option B: Containerized Node app (Yarn-based image)
- Build the image:
  - docker build -t automatic-async-proxy .
- Run the container (exposes 3000):
  - docker run --rm -p 3000:3000 -e AUTH_TOKEN=your-secure-api-token automatic-async-proxy
- Open the docs:
  - http://localhost:3000/doc

Option C: Docker Compose (reads .env if available)
- Prepare environment:
  - cp .env.example .env
  - Edit .env and set at minimum AUTH_TOKEN (and optionally PORT, DB_PATH, etc.)
- Start with compose:
  - docker compose up --build
- Access:
  - Swagger UI: http://localhost:${PORT:-3000}/doc
  - Health: http://localhost:${PORT:-3000}/health
Notes:
- The provided docker-compose.yml will read variables from your local .env and also pass them into the container.
- You can override the port without editing files: PORT=4000 docker compose up --build

Persistence and SQLite volume
- The Compose file mounts a named volume at /data inside the container: `db-data:/data`.
- The default DB_PATH is set to /data/jobs.db in .env.example so the SQLite file is persisted to the volume.
- Data persists across container restarts. To inspect on the host: `docker volume ls` then `docker run --rm -v <volume_name>:/data alpine ls -l /data`.
- To use a host bind instead of a named volume, replace the service volumes entry with `- ./data:/data` (ensure ./data exists and is writable), and keep DB_PATH=/data/jobs.db.

Quick usage examples
- Submit a job (txt2img):
  - curl -H "Authorization: Bearer your-secure-api-token" \
    -H "Content-Type: application/json" \
    -d '{"prompt":"a cat","webhookUrl":null,"webhookKey":null}' \
    http://localhost:3000/sdapi/v1/txt2img -i
- List jobs:
  - curl -H "Authorization: Bearer your-secure-api-token" http://localhost:3000/sdapi/v1/jobs
  Note: returns an array of job summaries (not wrapped in an object)
- Get a job:
  - curl -H "Authorization: Bearer your-secure-api-token" http://localhost:3000/sdapi/v1/jobs/<UUID>
- Cancel a job:
  - curl -X DELETE -H "Authorization: Bearer your-secure-api-token" http://localhost:3000/sdapi/v1/jobs/<UUID>
  Note: returns HTTP 204 No Content on success

- Get models (spec path uses sd-models):
  - curl -H "Authorization: Bearer your-secure-api-token" http://localhost:3000/sdapi/v1/sd-models
- Get loras:
  - curl -H "Authorization: Bearer your-secure-api-token" http://localhost:3000/sdapi/v1/loras

Validation tips
- Load the YAML in Swagger Editor if you prefer a desktop validation.
- Consider adding swagger-cli or openapi-generator-cli validate steps in CI for structural validation.
