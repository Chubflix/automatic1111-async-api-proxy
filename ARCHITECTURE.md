# Architecture Specification for Async Automatic1111 API Wrapper

This document outlines the architecture of an asynchronous API wrapper around the Automatic1111 Stable Diffusion Web UI, designed to handle image generation requests with job queueing, progress tracking, secure per-request webhook notifications, and extended model metadata. The architecture enables scalability, security, and easy client integration.

***

## System Components

### 1. API Server (Express.js)

- **Role:**  
  Provides HTTP REST API endpoints mimicking Automatic1111’s API for image generation:
    - `/sdapi/v1/txt2img`
    - `/sdapi/v1/img2img`

- **Features:**
    - Accepts generation jobs, immediately returns a job UUID.
    - Accepts optional webhook URL and webhook secret key per job.
    - Provides job management endpoints:
        - List all jobs with progress summary
        - Retrieve detailed job progress and results
        - Cancel queued or running jobs
    - Provides models and LoRas list/detail endpoints, enriched with optional Civitai metadata.
    - Implements token-based bearer authentication configurable via environment variables.
    - Serves Swagger UI documentation at `/doc`.
    - Exposes a `/health` endpoint to monitor the server status.

- **Persistence:**
    - Uses SQLite for persistent job storage and state.
    - Stores job request parameters, progress, status, results, webhook info.

***

### 2. Background Worker (Node.js Process)

- **Role:**  
  Consumes queued jobs from the SQLite database asynchronously.

- **Features:**
    - Polls for jobs in `"queued"` status.
    - Executes image generation requests against the real Automatic1111 API.
    - Updates job progress, status, and images in the database.
    - On job completion, sends webhook callback including the per-request secret key for authentication.
    - Sends periodic health pings to API server.

- **Behavior:**
    - Runs as a separate process for isolation and scalability.
    - Ensures serialized job execution or configurable concurrency.
    - Handles failures by marking jobs as `"error"` and applying retries if needed.

***

### 3. Client Applications (this will be implemented in a different project)

- **Role:**  
  Interface with the async API to submit image generation jobs, poll progress, and optionally receive webhook callbacks.

- **Features:**
    - Submit requests with generation parameters plus optional webhook URL and secret key.
    - Poll job progress via `/sdapi/v1/jobs/{uuid}`.
    - Validate webhook callbacks with the secret key for security.
    - Use Swagger UI served by the API for discovery and integration.

***

### 4. Infrastructure / Deployment

- **Configuration:**
    - Environment variables for API token, SQLite database path, Automatic1111 API base URL, and server port.
- **Containerization:**
    - Docker container running both API server and worker (for development/small scale).
    - Healthchecks monitor API and worker health; container restarts on failure.
- **Scaling:**
    - Separate containers recommended for larger scale (API server and worker process).
    - Potential future enhancements include advanced job queues (Redis, RabbitMQ) or streaming progress endpoints.

***

## Data Flow

1. Client sends job request to API with generation params and optional webhook URL/key.
2. API stores job as `"queued"` in SQLite and returns UUID immediately.
3. Worker polls SQLite, picks the next queued job, marks `"processing"`.
4. Worker calls Automatic1111 API synchronously for generation.
5. Worker updates progress and upon completion sets job `"completed"` with base64 images.
6. Worker sends webhook callback, including the secret key header.
7. Clients poll job progress or receive webhook notification to retrieve results.

***

## Security Considerations

- Use bearer token authentication on API endpoints.
- Use per-request webhook keys transmitted securely via headers for callback validation.
- Avoid exposing internal APIs; use network and firewall protections.
- Sanitize and validate all inputs and outputs rigorously.

***

## API Specification & Documentation

- Fully OpenAPI 3.0 compatible spec referencing Automatic1111 core schemas.
- Extends request schemas with webhook URL and secret key.
- Includes job management, models, and LoRas endpoints.
- Swagger UI documentation exposed under `/doc`.

***

## Summary

This architecture ensures a robust, scalable, and secure asynchronous interface for Automatic1111 stable diffusion image generation, enabling flexible integration with clients while supporting advanced webhook security and enriched model metadata.
