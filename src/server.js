const express = require('express');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const a1111 = require('./a1111');
require('dotenv').config();
const createLogger = require('./logger');
const log = createLogger('server');

// App config
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS: allow browser clients to call the API (configurable via CORS_ORIGINS)
// CORS_ORIGINS: comma-separated list of allowed origins, or "*" to allow all (default "*")
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const reqOrigin = req.headers.origin;
  const allowAll = CORS_ORIGINS.length === 0 || (CORS_ORIGINS.length === 1 && CORS_ORIGINS[0] === '*');
  if (allowAll) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (reqOrigin && CORS_ORIGINS.includes(reqOrigin)) {
    res.header('Access-Control-Allow-Origin', reqOrigin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  // No credentials by default; if needed, can be toggled later with config
  // res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

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

// Utility: civitai source detection (supports web URLs and AIR tags)
function isCivitaiUrl(url) {
  const s = String(url || '');
  // AIR tag e.g. urn:air:sdxl:lora:civitai:1836860@2078658
  if (s.toLowerCase().startsWith('urn:air:') && s.toLowerCase().includes(':civitai:')) {
    return true;
  }
  try {
    const u = new URL(s);
    return u.hostname.includes('civitai.com');
  } catch (_e) {
    return false;
  }
}

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

// Submit Florence job (async)
api.post('/v1/florence', (req, res) => {
  const { webhookUrl = null, webhookKey = null, imageUrl, mode, task, prompt } = req.body || {};
  if (!imageUrl || !task) {
    return res.status(400).json({ error: 'imageUrl and task are required' });
  }
  const id = uuidv4();
  const job = {
    uuid: id,
    status: 'queued',
    progress: 0,
    request: {
      type: 'florence',
      imageUrl: String(imageUrl),
      mode: mode ? String(mode) : undefined,
      task: String(task),
      prompt: prompt == null ? '' : String(prompt),
    },
    result: null,
    error: null,
    webhookUrl,
    webhookKey,
  };
  db.createJob(job);
  return res.status(202).json({ uuid: id });
});

// Asset download request (models or loras)
// Initial request only accepts { kind: 'model'|'lora', url: string } and enqueues a job in jobs table.
api.post('/v1/assets/download', (req, res) => {
  const { kind, url } = req.body || {};
  const k = String(kind || '').toLowerCase();
  if (k !== 'model' && k !== 'lora') {
    return res.status(400).json({ error: "kind must be 'model' or 'lora'" });
  }
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  const id = uuidv4();
  const job = {
    uuid: id,
    status: 'queued',
    progress: 0,
    request: {
      type: 'asset-download',
      kind: k,
      source_url: String(url),
      civitai: isCivitaiUrl(url),
    },
    result: null,
    error: null,
    webhookUrl: null,
    webhookKey: null,
  };
  db.createJob(job);
  // Return the job uuid; further metadata (name, image_url, min/max, etc.) can be set via future edits/endpoints.
  return res.status(202).json({ uuid: id });
});

// Get asset by id
api.get('/v1/assets/:id', (req, res) => {
  const asset = db.getAsset(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  // Spec change: AssetsResponse no longer includes status or error
  const { status, error, ...rest } = asset || {};
  return res.json(rest);
});

// List jobs summary (active only: queued, processing, or webhook)
api.get('/v1/jobs', (_req, res) => {
  const list = db.listActiveJobsSummary().map((r) => ({
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
api.get('/v1/sd-models', async (_req, res) => {
  try {
    // If base not configured, return empty list per spec shape
    if (!process.env.AUTOMATIC1111_API_BASE) return res.json({ models: [] });
    const models = await a1111.listSdModels();
    // Pass-through array as-is, but wrap to match our spec { models: [] }
    return res.json(Array.isArray(models) ? models : []);
  } catch (e) {
    // On error, degrade gracefully to empty list to keep API stable
    return res.json([]);
  }
});
// Model detail placeholder
api.get('/v1/sd-models/:modelId', (req, res) => {
  return res.status(404).json({ error: 'Model not found' });
});
api.get('/v1/loras', async (_req, res) => {
  try {
    if (!process.env.AUTOMATIC1111_API_BASE) return res.json({ loras: [] });
    const loras = await a1111.listLoras();
    return res.json(Array.isArray(loras) ? loras : []);
  } catch (_e) {
    return res.json([]);
  }
});
// LoRa detail placeholder
api.get('/v1/loras/:loraId', (req, res) => {
  return res.status(404).json({ error: 'LoRa not found' });
});

// Options passthrough to Automatic1111 (authorized)
api.get('/v1/options', async (_req, res) => {
  try {
    if (!process.env.AUTOMATIC1111_API_BASE) {
      return res.status(503).json({ error: 'AUTOMATIC1111_API_BASE not configured' });
    }
    const options = await a1111.getOptions();
    return res.json(options ?? {});
  } catch (e) {
    const msg = e && (e.body || e.message) ? `${e.message}${e.body ? ': ' + String(e.body).slice(0, 500) : ''}` : 'Upstream error';
    return res.status(502).json({ error: msg });
  }
});

api.post('/v1/options', async (req, res) => {
  try {
    if (!process.env.AUTOMATIC1111_API_BASE) {
      return res.status(503).json({ error: 'AUTOMATIC1111_API_BASE not configured' });
    }
    const resp = await a1111.setOptions(req.body || {});
    // A1111 typically echoes changed options or empty object
    return res.json(resp ?? {});
  } catch (e) {
    const msg = e && (e.body || e.message) ? `${e.message}${e.body ? ': ' + String(e.body).slice(0, 500) : ''}` : 'Upstream error';
    return res.status(502).json({ error: msg });
  }
});

app.use('/sdapi', api);

app.listen(PORT, () => {
  log.info(`Swagger UI available at http://localhost:${PORT}/doc`);
});
