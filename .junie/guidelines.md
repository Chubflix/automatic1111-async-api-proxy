Project-specific development guidelines

Overview
This repository currently provides the OpenAPI specification and high-level docs for an asynchronous drop-in replacement API around Automatic1111. There is no executable service code here yet; the focus is on the API contract (OpenAPI) and documentation. The architecture assumes an Express.js API server plus a background worker that speaks to an Automatic1111 instance, with SQLite persistence and optional webhook callbacks.

Build and configuration
- Environment variables: A sample .env.example is included to document the expected configuration once the service implementation is added.
  - AUTH_TOKEN: Bearer token expected by the API server.
  - DB_PATH: SQLite database file path for job storage.
  - AUTOMATIC1111_API_BASE: Base URL for a running Automatic1111 instance that the worker will call.
  - PORT: Port where the API server would listen.
  - CIVIT_AI_TOKEN and CIVIT_AI_ENDPOINT: For enriching model/LoRA metadata from Civitai.
- Spec usage:
  - Primary spec file: schemas/openapi.spec.yaml
  - External reference: schemas/automatic1111.spec.json (referenced via $ref for core Automatic1111 schemas)
  - The spec declares bearerAuth security and extends request bodies with webhookUrl and webhookKey.
- Serving the spec:
  - During implementation, wire this spec to Swagger UI (e.g., swagger-ui-express) at /doc. For local testing before code exists, you can serve the YAML using any static file server or load it in Swagger Editor.

Testing information
- Goal: Ensure the OpenAPI contract remains consistent, references resolve, and required sections are present.
- Minimal test approach used here:
  - A temporary shell script was used to sanity-check the presence and key markers of the OpenAPI and referenced schema files. It verified:
    - schemas/openapi.spec.yaml exists and contains the openapi: 3.0.x header and the components: section with bearerAuth.
    - schemas/automatic1111.spec.json exists and is referenced from the YAML via $ref.
  - The script exited successfully on this repository at the time of writing.
- How to run similar checks locally:
  1) Create a temporary script (for example scripts/test_spec.sh):
     - Validate file existence (YAML and JSON).
     - Grep for key sections: openapi:, components:, securitySchemes.bearerAuth, and $ref to automatic1111.spec.json.
  2) Run the script; ensure it exits 0 and prints OK lines for each check.
  3) Remove the temporary script when done to keep the repo clean.
- Adding richer tests (recommended for service implementation):
  - Use swagger-cli validate or openapi-generator-cli validate to fully lint/validate the spec (catches structural issues beyond simple greps).
  - Add CI that runs on every PR/commit to validate the schema and optionally bundle it to catch broken $refs.
  - Include contract tests once the API implementation exists (e.g., Dredd or schemathesis) to verify responses match the spec.

Development notes and conventions
- OpenAPI style:
  - Keep schemas in schemas/ and prefer external refs for large third-party contracts (as with Automatic1111).
  - Maintain semantic versioning in info.version; bump patch for doc-only clarifications, minor for backward-compatible additions, major for breaking changes.
  - Prefer allOf for additive extensions to third-party request/response bodies; avoid duplicating upstream schema content.
  - Clearly mark nullable fields and describe any extended fields (e.g., webhookUrl, webhookKey, civitai objects).
- Security:
  - All API endpoints are protected by bearerAuth. Any implementation should enforce AUTH_TOKEN matching and return 401/403 appropriately.
  - Webhook callbacks must include the per-request webhookKey in a header for verification by the consumer.
- Jobs and status model:
  - Job statuses: queued, processing, completed, error, canceled.
  - Progress range: 0..1 float.
  - Images: base64-encoded strings returned after completion; keep empty until complete to minimize payload size.
- Civitai metadata:
  - Model and LoRa listings include optional nested civitai objects to carry external metadata. Ensure these are clearly nullable and only populated when available.

Documentation location policy
- Beyond ARCHITECTURE.md and PROJECT.md at the root (and README.md if added), place all additional documentation under /docs.
- Suggested structure:
  - docs/usage.md for endpoint walkthroughs and example payloads.
  - docs/deployment.md for containerization and environment details.
  - docs/webhooks.md detailing callback contracts and verification.
  - docs/models.md describing metadata enrichment and sources.

Notes for future implementation
- When service code is introduced:
  - Provide npm scripts for: lint, test, start, worker, and an openapi:validate step (using swagger-cli or openapi-generator-cli).
  - Add CI to validate the spec and run tests.
  - Wire Swagger UI to serve schemas/openapi.spec.yaml at /doc.
  - Persist jobs in SQLite at DB_PATH; ensure migrations/init are idempotent.
  - Ensure the worker respects concurrency configuration and safe retries.

Simple test performed
- A temporary shell-based test validated the current repository’s OpenAPI contract presence and essential references. It passed on 2025-11-24. The temporary files were subsequently removed as required.
