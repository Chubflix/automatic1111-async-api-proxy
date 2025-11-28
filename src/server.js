require('dotenv').config();
const express = require('express');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const {v4: uuidv4} = require('uuid');
const a1111 = require('./libs/a1111');
const {initDb, getDb} = require('./libs/db');
const {runMigrations} = require('./libs/migration');
const createLogger = require('./libs/logger');
const fs = require("fs/promises");
const log = createLogger('server');
let db = null;

// App config
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = express();
app.use(express.json({limit: '10mb'}));

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
        return res.status(503).json({error: 'Server auth not configured'});
    }
    if (!token || token !== AUTH_TOKEN) {
        return res.status(401).json({error: 'Unauthorized'});
    }
    return next();
}

// Health endpoint
app.get('/health', (_req, res) => {
    res.status(200).json({status: 'ok'});
});

const schemasDir = path.join(__dirname, '..', 'schemas');
app.use('/schemas', express.static(schemasDir, {fallthrough: true}));

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

app.get('/', (_req, res) => res.redirect('/doc'));

app.get('/public/jobs.json', (_req, res) => {
    try {
        // TODO: map structure to spec
        const jobs = db.jobs.listActive();
        res.status(200).json({jobs, updatedAt: new Date().toISOString()});
    } catch (e) {
        log.error('Failed to list active jobs:', e && e.message ? e.message : e);
        res.status(500).json({error: 'Failed to list jobs'});
    }
});

app.get('/public/failed-jobs.json', (_req, res) => {
    try {
        const jobs = db.jobs.recentErrors(20);
        res.status(200).json({jobs, updatedAt: new Date().toISOString()});
    } catch (e) {
        log.error('Failed to list failed jobs:', e && e.message ? e.message : e);
        res.status(500).json({error: 'Failed to list failed jobs'});
    }
});

app.get('/jobs', async (_req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8').send(await fs.readFile(path.join(__dirname, 'static', 'status.html'), 'utf8'));
});

const api = express.Router();
api.use(requireAuth);

function isCivitaiUrl(url) {
    const s = String(url || '');
    try {
        const u = new URL(s);
        return u.hostname.includes('civitai.com');
    } catch (_e) {
        return false;
    }
}

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

api.post('/v1/txt2img', (req, res) => {
    const {webhookUrl = null, webhookKey = null, ...rest} = req.body || {};
    const id = uuidv4();
    const job = {
        uuid: id,
        status: 'pending',
        workflow: 'txt2img',
        progress: 0,
        request: rest || {},
        result: null,
        error: null,
        webhookUrl,
        webhookKey,
    };
    db.jobs.create(job);
    return res.status(202).json({uuid: id});
});

api.post('/v1/img2img', (req, res) => {
    const {webhookUrl = null, webhookKey = null, ...rest} = req.body || {};
    const id = uuidv4();
    const job = {
        uuid: id,
        status: 'pending',
        workflow: 'img2img',
        progress: 0,
        request: rest || {},
        result: null,
        error: null,
        webhookUrl,
        webhookKey,
    };
    db.jobs.create(job);
    return res.status(202).json({uuid: id});
});

api.post('/v1/florence', (req, res) => {
    const {webhookUrl = null, webhookKey = null, imageUrl, mode, task, prompt} = req.body || {};
    if (!imageUrl || !task) {
        return res.status(400).json({error: 'imageUrl and task are required'});
    }
    const id = uuidv4();
    const job = {
        uuid: id,
        status: 'pending',
        workflow: 'florence',
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
    db.jobs.create(job);
    return res.status(202).json({uuid: id});
});

api.post('/v1/assets/download', (req, res) => {
    const {kind, url} = req.body || {};
    const k = String(kind || '').toLowerCase();
    if (k !== 'model' && k !== 'lora') {
        return res.status(400).json({error: "kind must be 'model' or 'lora'"});
    }
    if (!url || typeof url !== 'string') {
        return res.status(400).json({error: 'url is required'});
    }

    // Normalize AIR tags to CivitAI URLs; reject invalid AIRs
    const normalizedUrl = normalizeAssetSourceUrl(String(url));
    if (String(url).toLowerCase().startsWith('urn:air:') && !normalizedUrl) {
        return res.status(400).json({error: 'Invalid AIR tag. Expected civitai provider with model@version.'});
    }

    const id = uuidv4();
    const job = {
        uuid: id,
        status: 'pending',
        workflow: isCivitaiUrl(normalizedUrl) ? 'civitai-download' : 'asset-download',
        progress: 0,
        request: {
            kind: k,
            source_url: normalizedUrl,
        },
        result: null,
        error: null,
        webhookUrl: null,
        webhookKey: null,
    };
    db.jobs.create(job);
    // Return the job uuid; further metadata (name, image_url, min/max, etc.) can be set via future edits/endpoints.
    return res.status(202).json({uuid: id});
});

api.get('/v1/assets/:id', (req, res) => {
    const asset = db.assets.get(req.params.id);
    if (!asset) return res.status(404).json({error: 'Not found'});
    // Spec change: AssetsResponse no longer includes status or error
    const {status, error, ...rest} = asset || {};
    return res.json(rest);
});

api.get('/v1/assets', (req, res) => {
    const kind = req.query && req.query.kind ? String(req.query.kind).toLowerCase() : null;
    if (kind && kind !== 'model' && kind !== 'lora') {
        return res.status(400).json({error: "kind must be 'model' or 'lora'"});
    }
    const list = db.assets.list(kind || undefined);
    return res.json(list);
});

api.get('/v1/jobs', (_req, res) => {
    const list = db.jobs.listActive().map((r) => ({
        uuid: r.uuid,
        job_status: r.status,
        workflow: r.workflow,
        retry_count: r.retry_count,
        progress: r.progress,
        type: r.workflow,
        created_at: r.created_at || null,
    }));
    return res.json(list);
});

api.get('/v1/errors', (req, res) => {
    const limit = req.query && req.query.limit ? Number(req.query.limit) : 50;
    const items = db.jobs.recentErrors(limit);
    return res.json(items);
});

api.get('/v1/jobs/:uuid', (req, res) => {
    const job = db.jobs.get(req.params.uuid);
    if (!job) return res.status(404).json({error: 'Not found'});
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

api.delete('/v1/jobs/:uuid', (req, res) => {
    const ok = db.jobs.cancel(req.params.uuid);
    if (!ok) return res.status(404).end();
    return res.status(204).end();
});

api.get('/v1/sd-models', async (_req, res) => {
    try {
        // If base not configured, return empty list per spec shape
        if (!process.env.AUTOMATIC1111_API_BASE) return res.json({models: []});
        const models = await a1111.listSdModels();
        // Pass-through array as-is, but wrap to match our spec { models: [] }
        return res.json(Array.isArray(models) ? models : []);
    } catch (e) {
        // On error, degrade gracefully to empty list to keep API stable
        return res.json([]);
    }
});


api.get('/v1/sd-models/:modelId', (req, res) => {
    return res.status(404).json({error: 'Model not found'});
});
api.get('/v1/loras', async (_req, res) => {
    try {
        if (!process.env.AUTOMATIC1111_API_BASE) return res.json({loras: []});
        const loras = await a1111.listLoras();
        return res.json(Array.isArray(loras) ? loras : []);
    } catch (_e) {
        return res.json([]);
    }
});

api.get('/v1/loras/:loraId', (req, res) => {
    return res.status(404).json({error: 'LoRa not found'});
});

api.get('/v1/options', async (_req, res) => {
    try {
        if (!process.env.AUTOMATIC1111_API_BASE) {
            return res.status(503).json({error: 'AUTOMATIC1111_API_BASE not configured'});
        }
        const options = await a1111.getOptions();
        return res.json(options ?? {});
    } catch (e) {
        const msg = e && (e.body || e.message) ? `${e.message}${e.body ? ': ' + String(e.body).slice(0, 500) : ''}` : 'Upstream error';
        return res.status(502).json({error: msg});
    }
});

api.post('/v1/options', async (req, res) => {
    try {
        if (!process.env.AUTOMATIC1111_API_BASE) {
            return res.status(503).json({error: 'AUTOMATIC1111_API_BASE not configured'});
        }
        const resp = await a1111.setOptions(req.body || {});
        // A1111 typically echoes changed options or empty object
        return res.json(resp ?? {});
    } catch (e) {
        const msg = e && (e.body || e.message) ? `${e.message}${e.body ? ': ' + String(e.body).slice(0, 500) : ''}` : 'Upstream error';
        return res.status(502).json({error: msg});
    }
});

app.use('/sdapi', api);

async function startup() {
    await runMigrations(getDb());
    app.locals.db = db = initDb();

    app.listen(PORT, () => {
        console.log(`✅ Server ready on ${PORT}`);
    });
}

startup().catch(error => {
    console.error('💥 Startup failed:', error);
    process.exit(1);
});