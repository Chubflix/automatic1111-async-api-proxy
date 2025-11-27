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

// Public endpoints for viewing active jobs (no auth)
// JSON: ordered list of jobs currently processing (top), then queued, then waiting webhook (bottom)
app.get('/public/jobs.json', (_req, res) => {
  try {
    const jobs = db.listActiveJobs();
    res.status(200).json({ jobs, updatedAt: new Date().toISOString() });
  } catch (e) {
    log.error('Failed to list active jobs:', e && e.message ? e.message : e);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

// JSON: last 20 failed jobs with error reasons
app.get('/public/failed-jobs.json', (_req, res) => {
  try {
    const jobs = db.listLastFailedJobs(20);
    res.status(200).json({ jobs, updatedAt: new Date().toISOString() });
  } catch (e) {
    log.error('Failed to list failed jobs:', e && e.message ? e.message : e);
    res.status(500).json({ error: 'Failed to list failed jobs' });
  }
});

// Simple auto-updating HTML page
app.get('/jobs', (_req, res) => {
  const html = `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Active Jobs</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 20px; }
      h1 { font-size: 1.25rem; }
      table { border-collapse: collapse; width: 100%; max-width: 900px; }
      th, td { border: 1px solid #ddd; padding: 8px; }
      th { background: #f5f5f5; text-align: left; }
      tr:nth-child(even) { background: #fafafa; }
      .status { text-transform: capitalize; font-weight: 600; }
      .bar { height: 10px; background: #eee; border-radius: 4px; overflow: hidden; }
      .bar > span { display: block; height: 100%; background: #4caf50; }
      .footer { color: #666; font-size: 12px; margin-top: 10px; }
      .section { margin-top: 28px; }
      code { white-space: nowrap; }
      .error { color: #b00020; }
    </style>
  </head>
  <body>
    <h1>Active Jobs (processing, queued, webhook)</h1>
    <div class="footer">Auto-updates every second</div>
    <table>
      <thead>
        <tr><th>#</th><th>UUID</th><th>Status</th><th>Progress</th></tr>
      </thead>
      <tbody id="rows"><tr><td colspan="4">Loading…</td></tr></tbody>
    </table>
    <div class="footer" id="meta"></div>

    <div class="section">
      <h1>Last 20 failed jobs</h1>
      <table>
        <thead>
          <tr><th>#</th><th>UUID</th><th>Error</th></tr>
        </thead>
        <tbody id="failedRows"><tr><td colspan="3">Loading…</td></tr></tbody>
      </table>
      <div class="footer" id="metaFailed"></div>
    </div>
    <script>
      function escapeHtml(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }
      async function refresh() {
        try {
          const [resActive, resFailed] = await Promise.all([
            fetch('/public/jobs.json', { cache: 'no-store' }),
            fetch('/public/failed-jobs.json', { cache: 'no-store' })
          ]);
          const data = await resActive.json();
          const failed = await resFailed.json();
          const tbody = document.getElementById('rows');
          if (!Array.isArray(data.jobs) || data.jobs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4">No active jobs</td></tr>';
          } else {
            tbody.innerHTML = data.jobs.map(function(j, idx) {
              var pct = Math.round((Number(j.progress) || 0) * 100);
              return '<tr>' +
                '<td>' + (idx + 1) + '</td>' +
                '<td><code>' + escapeHtml(j.uuid) + '</code></td>' +
                '<td class="status">' + j.status + '</td>' +
                '<td>' +
                  '<div class="bar"><span style="width:' + pct + '%;"></span></div>' +
                  '<div>' + pct + '%</div>' +
                '</td>' +
              '</tr>';
            }).join('');
          }
          const meta = document.getElementById('meta');
          meta.textContent = 'Last updated: ' + (data.updatedAt || new Date().toISOString());

          const tbodyFailed = document.getElementById('failedRows');
          if (!Array.isArray(failed.jobs) || failed.jobs.length === 0) {
            tbodyFailed.innerHTML = '<tr><td colspan="3">No failed jobs</td></tr>';
          } else {
            tbodyFailed.innerHTML = failed.jobs.map(function(j, idx) {
              var err = escapeHtml(j.error || 'Unknown error');
              return '<tr>' +
                '<td>' + (idx + 1) + '</td>' +
                '<td><code>' + escapeHtml(j.uuid) + '</code></td>' +
                '<td class="error">' + err + '</td>' +
              '</tr>';
            }).join('');
          }
          const metaFailed = document.getElementById('metaFailed');
          metaFailed.textContent = 'Last updated: ' + (failed.updatedAt || new Date().toISOString());
        } catch (e) {
          const tbody = document.getElementById('rows');
          tbody.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
          const tbodyFailed = document.getElementById('failedRows');
          tbodyFailed.innerHTML = '<tr><td colspan="3">Failed to load</td></tr>';
        }
      }
      refresh();
      setInterval(refresh, 1000);
    </script>
  </body>
  </html>`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

// Protected API routes under /sdapi
const api = express.Router();
api.use(requireAuth);

// Utility: civitai source detection (supports web URLs and AIR tags)
function isCivitaiUrl(url) {
  const s = String(url || '');
  try {
    const u = new URL(s);
    return u.hostname.includes('civitai.com');
  } catch (_e) {
    return false;
  }
}

// Normalize asset source URL: convert AIR tags to CivitAI web URLs to avoid passing AIR into worker
function normalizeAssetSourceUrl(input) {
  const s = String(input || '').trim();
  if (!s) return s;
  const lower = s.toLowerCase();
  if (lower.startsWith('urn:air:')) {
    // Expect pattern ...:civitai:<modelId>@<versionId>
    if (!lower.includes(':civitai:')) return null;
    try {
      const last = s.split(':').pop();
      if (!last || !last.includes('@')) return null;
      const [modelId, versionId] = last.split('@');
      if (!modelId || !versionId) return null;
      // Build canonical CivitAI URL
      return `https://civitai.com/models/${encodeURIComponent(modelId)}?modelVersionId=${encodeURIComponent(versionId)}`;
    } catch (_e) {
      return null;
    }
  }
  return s;
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

  // Normalize AIR tags to CivitAI URLs; reject invalid AIRs
  const normalizedUrl = normalizeAssetSourceUrl(String(url));
  if (String(url).toLowerCase().startsWith('urn:air:') && !normalizedUrl) {
    return res.status(400).json({ error: 'Invalid AIR tag. Expected civitai provider with model@version.' });
  }

  const id = uuidv4();
  const job = {
    uuid: id,
    status: 'queued',
    progress: 0,
    request: {
      type: 'asset-download',
      kind: k,
      source_url: normalizedUrl,
      civitai: isCivitaiUrl(normalizedUrl),
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

// List all assets with optional kind filter (?kind=model|lora)
api.get('/v1/assets', (req, res) => {
  const kind = req.query && req.query.kind ? String(req.query.kind).toLowerCase() : null;
  if (kind && kind !== 'model' && kind !== 'lora') {
    return res.status(400).json({ error: "kind must be 'model' or 'lora'" });
  }
  const list = db.listAssets(kind || undefined);
  return res.json(list);
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

// List recent job errors (most recent first). Optional ?limit=50
api.get('/v1/errors', (req, res) => {
  const limit = req.query && req.query.limit ? Number(req.query.limit) : 50;
  const items = db.listRecentErrors(limit);
  return res.json(items);
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
