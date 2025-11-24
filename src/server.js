const express = require('express');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
require('dotenv').config();

// App config
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = express();
app.use(express.json({ limit: '10mb' }));

// Simple bearer auth middleware for protected routes
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!AUTH_TOKEN) {
    // If not configured, deny to avoid accidental exposure
    return res.status(503).json({ error: 'Server auth not configured' });
  }
  if (!token || token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

// Health endpoint
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Serve the schemas directory statically so the browser can fetch the YAML and resolve $refs
const schemasDir = path.join(__dirname, '..', 'schemas');
app.use('/schemas', express.static(schemasDir, { fallthrough: true }));

// Serve Swagger UI at /doc, instructing it to load our YAML spec by URL.
// Passing a URL preserves relative $ref resolution to other files under /schemas.
app.use(
  '/doc',
  swaggerUi.serve,
  swaggerUi.setup(undefined, {
    explorer: true,
    swaggerOptions: {
      url: '/schemas/openapi.spec.yaml',
    },
  })
);

// Optional redirect from root to docs for convenience
app.get('/', (_req, res) => res.redirect('/doc'));

// Protected API routes under /sdapi
const api = express.Router();
api.use(requireAuth);

// Submit txt2img (async)
api.post('/v1/txt2img', (req, res) => {
  const { webhookUrl = null, webhookKey = null, ...rest } = req.body || {};
  const id = uuidv4();
  const job = {
    uuid: id,
    status: 'queued',
    progress: 0,
    request: rest || {},
    result: null,
    error: null,
    webhookUrl,
    webhookKey,
  };
  db.createJob(job);
  return res.status(202).json({ uuid: id });
});

// Submit img2img (async)
api.post('/v1/img2img', (req, res) => {
  const { webhookUrl = null, webhookKey = null, ...rest } = req.body || {};
  const id = uuidv4();
  const job = {
    uuid: id,
    status: 'queued',
    progress: 0,
    request: rest || {},
    result: null,
    error: null,
    webhookUrl,
    webhookKey,
  };
  db.createJob(job);
  return res.status(202).json({ uuid: id });
});

// List jobs summary (spec: returns an array of JobSummary)
api.get('/v1/jobs', (_req, res) => {
  const list = db.listJobsSummary().map((r) => ({
    uuid: r.uuid,
    job_status: r.status,
    progress: r.progress,
  }));
  return res.json(list);
});

// Get job details
api.get('/v1/jobs/:uuid', (req, res) => {
  const job = db.getJob(req.params.uuid);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const images = job.result && Array.isArray(job.result.images) ? job.result.images : [];
  const info = (job.result && job.result.info) ? job.result.info : (job.error ?? null);
  const payload = {
    uuid: job.uuid,
    job_status: job.status,
    progress: job.progress,
    images,
    info,
  };
  return res.json(payload);
});

// Cancel job (spec: 204 on success, 404 if not found or already completed)
api.delete('/v1/jobs/:uuid', (req, res) => {
  const ok = db.cancelJob(req.params.uuid);
  if (!ok) return res.status(404).end();
  return res.status(204).end();
});

// Models and LoRAs - minimal placeholders
// Note: Spec path is /sd-models (not /models)
api.get('/v1/sd-models', (_req, res) => {
  return res.json({ models: [] });
});
// Model detail placeholder
api.get('/v1/sd-models/:modelId', (req, res) => {
  return res.status(404).json({ error: 'Model not found' });
});
api.get('/v1/loras', (_req, res) => {
  return res.json({ loras: [] });
});
// LoRa detail placeholder
api.get('/v1/loras/:loraId', (req, res) => {
  return res.status(404).json({ error: 'LoRa not found' });
});

app.use('/sdapi', api);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Swagger UI available at http://localhost:${PORT}/doc`);
});
