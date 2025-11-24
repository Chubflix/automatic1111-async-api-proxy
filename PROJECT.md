# Async Automatic1111 API Wrapper with Webhook Security and Extended Metadata

This project is an asynchronous, drop-in replacement API wrapper for the Automatic1111 Stable Diffusion web UI, designed to provide robust job queueing, progress tracking, and flexible webhook callbacks with enhanced security and metadata support.

## Key Features

- **Asynchronous Job Handling:**  
  Wraps Automatic1111’s core image generation endpoints (`txt2img`, `img2img`) to accept job requests and immediately return a job UUID. A background worker processes jobs independently, updating progress and results in a persistent SQLite database.

- **Job Progress and Management Endpoints:**  
  Provides endpoints to list all jobs, fetch detailed job progress including base64-encoded images, and cancel queued or running jobs by UUID, with a `"canceled"` job status supported.

- **Per-Request Webhook Integration with Secret Keys:**  
  Jobs can specify an optional `webhookUrl` and a unique `webhookKey`. Upon job completion, the worker calls the webhook URL, including the secret key in a custom header for authentication. This enables secure, per-request webhook callbacks rather than relying on a global secret.

- **Extended Models and LoRas Meta**  
  The models and LoRas listing and detail endpoints are extended to include optional nested `civitai` metadata objects, enriching model information with data imported from Civitai.

- **OpenAPI 3.0 Specification:**  
  Fully compatible with Automatic1111’s official API schema via external references, the API spec includes the async enhancements, webhook parameters, job management features, and metadata extensions. This facilitates easy client generation and integration.

- **Secure Access:**  
  The API is protected with bearer token authentication configurable via environment variables.

- **Background Worker Process:**  
  The image generation tasks are handled by a background Node.js worker process that polls the database for queued jobs, invokes the Automatic1111 API synchronously, updates job status, and triggers webhook callbacks.

- **Healthcheck and Robustness:**  
  A simple health endpoint monitors API server responsiveness.

- **Development Considerations:**  
  Supports environment variable configuration for auth token and database path, a `/doc` endpoint serving Swagger UI for API exploration, and client-side strategies to reduce redundant polling during development.

## Use Cases

- Integrate with frontends or automation pipelines that require asynchronous stable diffusion job handling.
- Securely notify clients of job completions with per-request webhook secrets.
- Maintain rich metadata on AI models and LoRas from Civitai alongside standard Automatic1111 data.
- Simplify scaling by decoupling API request handling from image generation workloads.
- Facilitate testing and development with full OpenAPI documentation and configurable environment variables.

