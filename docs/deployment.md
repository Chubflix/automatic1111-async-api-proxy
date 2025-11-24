Deployment and local serving of automatic-async-proxy (Express API + Swagger UI)

Overview
This repository now includes a minimal Express implementation of the async API wrapper (automatic-async-proxy). It serves:
- The documented API endpoints under /sdapi/v1/* (bearer-protected)
- Swagger UI at /doc
- Static schemas at /schemas for $ref resolution
- Health check at /health
- Optional live proxy to a running Automatic1111 instance for models/loras when AUTOMATIC1111_API_BASE is set

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
  - If AUTOMATIC1111_API_BASE is configured, GET /sdapi/v1/sd-models and /sdapi/v1/loras will proxy to the real Automatic1111 API and wrap the arrays into { models: [...] } and { loras: [...] } respectively.

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

Automatic1111 API client library
- The internal library at src/a1111.js provides thin wrappers for the Automatic1111 Web UI API.
- Configure AUTOMATIC1111_API_BASE (e.g., http://host.docker.internal:7860) so the server can talk to your A1111 instance.
- Currently used by the server to serve model/loras listings; intended for the background worker to submit txt2img/img2img to A1111.

GitHub Container Registry (GHCR) images
- The repository includes a GitHub Actions workflow that builds and publishes the Docker image to GHCR on pushes to the default branch and on tags.
- Image name format: ghcr.io/<owner>/<repo>
- Pull the latest image:
  - docker pull ghcr.io/<owner>/<repo>:latest
- Use a tagged release (example v1.2.3):
  - docker pull ghcr.io/<owner>/<repo>:v1.2.3
- Use in Docker Compose instead of building locally:
  - Replace the service build section with:
    image: ghcr.io/<owner>/<repo>:latest
  - Ensure your .env still provides AUTH_TOKEN and DB_PATH (default /data/jobs.db) and keep the /data volume mapping for persistence.

Multi-architecture support
- The CI workflow builds and publishes multi-arch images for both linux/amd64 and linux/arm64 using Docker Buildx and QEMU emulation.
- Docker will automatically pull the correct image for your platform. On Apple Silicon (M1/M2/M3), the arm64 variant will be used; on most cloud VMs and PCs, the amd64 variant will be used.

Background worker
- Purpose: Polls the SQLite DB for queued jobs and executes them against the configured Automatic1111 instance.
- Local run:
  - Ensure AUTOMATIC1111_API_BASE points to a reachable A1111 Web UI instance.
  - Start server in one terminal: AUTH_TOKEN=... DB_PATH=./data/jobs.db yarn start
  - Start worker in another terminal: AUTOMATIC1111_API_BASE=http://localhost:7860 DB_PATH=./data/jobs.db yarn worker
  - Optional: set WORKER_POLL_MS (default 2000) to adjust polling interval.
- Compose run:
  - docker compose up --build
  - This brings up two services:
    - automatic-async-proxy (API server)
    - automatic-async-proxy-worker (background worker)
  - Both share the /data volume for SQLite and read the same .env.
- Behavior:
  - Leases a single queued job at a time and marks it processing.
  - Chooses endpoint automatically: img2img if request.init_images exists, otherwise txt2img.
  - On success, stores result.images (base64 array) and info, marks completed, and triggers webhook if provided (header: X-Webhook-Key).
  - On failure, marks error and sends webhook with error info.

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
