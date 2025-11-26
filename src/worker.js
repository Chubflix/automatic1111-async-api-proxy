// Background worker that processes queued jobs using Automatic1111 API
// Minimal single-threaded polling worker with SQLite leasing

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const a1111 = require('./a1111');
const florence = require('./florence');
const createLogger = require('./logger');
const log = createLogger('worker');

const POLL_MS = process.env.WORKER_POLL_MS ? Number(process.env.WORKER_POLL_MS) : 2000;
const ENABLE_PROGRESS_TICKS = true;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chooseEndpoint(request) {
  if (request?.type === 'asset-download') return 'asset-download';
  if (request?.type === 'florence') return 'florence';
  // If init_images present/useful, treat as img2img; otherwise txt2img
  if (request && Array.isArray(request.init_images) && request.init_images.length > 0) return 'img2img';
  return 'txt2img';
}

async function sendWebhook(job, payload) {
  if (!job.webhookUrl) return false;
  try {
    const headers = { 'content-type': 'application/json' };
    if (job.webhookKey) headers['x-webhook-key'] = job.webhookKey;
    const resp = await fetch(job.webhookUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
    return !!resp && resp.ok;
  } catch (e) {
    log.warn('Webhook delivery failed for', job.uuid, e.message);
    return false;
  }
}

async function processOne(job) {
  // Indicate we started
  db.setProgress(job.uuid, 0.01);

  const kind = chooseEndpoint(job.request);
  try {
    if (ENABLE_PROGRESS_TICKS) db.setProgress(job.uuid, 0.1);

    let resultObj;
    if (kind === 'asset-download') {
      resultObj = await processAssetDownload(job);
    } else if (kind === 'florence') {
      const fr = await florence.run(job.request);
      // fr: { text, image }
      resultObj = {
        images: fr?.image ? [fr.image] : [],
        info: fr?.text || null,
      };
    } else {
      const result = kind === 'img2img' ? await a1111.img2img(job.request) : await a1111.txt2img(job.request);
      // Automatic1111 returns { images: [base64...], info: string/json-string }
      resultObj = {
        images: Array.isArray(result?.images) ? result.images : [],
        info: typeof result?.info === 'string' ? result.info : (result?.info ? JSON.stringify(result.info) : null),
      };
    }

    if (ENABLE_PROGRESS_TICKS) db.setProgress(job.uuid, 0.9);
    if (job.webhookUrl) {
      // Move to webhook-pending state first; finalize to completed only if webhook returns 2xx
      db.markWebhookPending(job.uuid, resultObj);
      const webhookPayload = {
        uuid: job.uuid,
        job_status: 'webhook',
        progress: 1,
        images: resultObj.images,
        info: resultObj.info,
      };
      const ok = await sendWebhook(job, webhookPayload);
      if (ok) {
        db.completeJob(job.uuid, resultObj);
      }
    } else {
      // No webhook configured; mark completed immediately
      db.completeJob(job.uuid, resultObj);
    }
  } catch (e) {
    const message = e && (e.body || e.message) ? `${e.message}${e.body ? ': ' + String(e.body).slice(0, 500) : ''}` : 'Unknown error';
    db.failJob(job.uuid, message);
    const webhookPayload = {
      uuid: job.uuid,
      job_status: 'error',
      progress: job.progress || 0,
      images: [],
      info: message,
    };
    await sendWebhook(job, webhookPayload);
  }
}

async function mainLoop() {
  log.info('Worker started. Poll interval:', POLL_MS, 'ms');
  // noinspection InfiniteLoopJS
    while (true) {
    try {
      const job = db.leaseNextQueuedJob();
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }
      log.debug('Processing job', job.uuid);
      await processOne(job);
    } catch (e) {
      log.error('Worker loop error:', e.message);
      await sleep(POLL_MS);
    }
  }
}

// Validate config
if (!process.env.AUTOMATIC1111_API_BASE) {
  log.warn('Warning: AUTOMATIC1111_API_BASE is not set. Worker cannot process jobs.');
}

mainLoop();

// ---------------- Asset download (CivitAI) ----------------
function isCivitaiUrl(url) {
  const s = String(url || '');
  try {
    const u = new URL(s);
    return u.hostname.includes('civitai.com');
  } catch (_e) {
    return false;
  }
}

function extractCivitaiVersionId(input) {
  const s = String(input || '');

  try {
    const u = new URL(s);
    const v = u.searchParams.get('modelVersionId');
    return v ? String(v) : null;
  } catch (_e) {
    return null;
  }
}

async function downloadToFile(downloadUrl, destFile, headers = {}) {
  const res = await fetch(downloadUrl, { headers });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const arr = await res.arrayBuffer();
  const buf = Buffer.from(arr);
  await fs.promises.mkdir(path.dirname(destFile), { recursive: true });
  await fs.promises.writeFile(destFile, buf);
  return destFile;
}

function uniquePath(dir, filename) {
  const base = path.basename(filename, path.extname(filename));
  const ext = path.extname(filename);
  let candidate = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

async function processAssetDownload(job) {
  const { kind, source_url } = job.request || {};
  // Defensive: AIR tags should be normalized on the server. Reject if any slip through.
  if (String(source_url || '').toLowerCase().startsWith('urn:air:')) {
    throw new Error('AIR tag must be normalized to a CivitAI URL on the server');
  }
  if (!isCivitaiUrl(source_url)) {
    db.failJob(job.uuid, 'Non CivitAI downloads are not supported at the moment');
    throw new Error('Non CivitAI downloads are not supported at the moment');
  }

  const versionId = extractCivitaiVersionId(source_url);
  if (!versionId) {
    throw new Error('CivitAI version id not specified');
  }

  const API_BASE = (process.env.CIVIT_AI_ENDPOINT || '').replace(/\/$/, '');
  const API_TOKEN = process.env.CIVIT_AI_TOKEN || '';
  if (!API_BASE) {
    throw new Error('CIVIT_AI_ENDPOINT not configured');
  }
  if (!API_TOKEN) {
    throw new Error('CIVIT_AI_TOKEN not configured');
  }

  // Fetch version metadata
  const versionUrl = `${API_BASE}/model-versions/${encodeURIComponent(versionId)}`;
  log.debug('Fetching CivitAI version metadata from', versionUrl);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` };
  const resp = await fetch(versionUrl, { headers });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`CivitAI fetch failed: ${resp.status} ${resp.statusText} - ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();

  // Choose file to download
  const files = Array.isArray(data.files) ? data.files : [];
  if (files.length === 0) {
    throw new Error('No downloadable files found for this CivitAI version');
  }
  const primary = files.find((f) => f.primary) || files[0];
  const fileName = primary.name || `civitai_${versionId}`;
  const downloadUrl = primary.downloadUrl || data.downloadUrl;
  if (!downloadUrl) {
    throw new Error('No downloadUrl provided by CivitAI');
  }

  const destDir = (String(kind) === 'lora') ? (process.env.LORAS_DIR || path.join(process.cwd(), 'loras'))
                                            : (process.env.MODELS_DIR || path.join(process.cwd(), 'models'));
  const destPath = uniquePath(destDir, fileName);

  // Some CivitAI downloads work with cookie auth; API usually allows Bearer
  await downloadToFile(downloadUrl, destPath, { authorization: `Bearer ${API_TOKEN}` });

  // Create asset record
  const trainedWords = Array.isArray(data.trainedWords) ? data.trainedWords : [];
  const examplePrompt = trainedWords.length ? trainedWords.join(', ') : null;
  const name = (data.model && data.model.name) ? data.model.name : (data.name || null);
  const images = Array.isArray(data.images) ? data.images : [];

  const assetId = db.createAsset({
    kind: String(kind),
    name,
    source_url: String(source_url),
    example_prompt: examplePrompt,
    min: 1,
    max: 1,
    local_path: destPath,
  });

  // Store images metadata
  for (const img of images) {
      const imageData = {
          asset_id: assetId,
          url: img.url,
          is_nsfw: !!img.nsfw,
          width: img.width ?? null,
          height: img.height ?? null,
          meta: img.meta ?? null,
      };
      try {
        db.addAssetImage(imageData);
    } catch (e) {
        log.error('Failed to store image metadata:', {error: e, img, imageData});
    }
  }

  // After successful download, ask Automatic1111 to refresh the relevant asset list
  try {
    if (String(kind) === 'lora') {
      await a1111.refreshLoras();
    } else {
      // treat all non-lora as checkpoints/models
      await a1111.refreshCheckpoints();
    }
  } catch (e) {
    // Do not fail the job if the refresh endpoint is unavailable; just log
    log.warn('Refresh request failed after asset download:', e && e.message ? e.message : e);
  }

  // Return a compact result object to store with the job
  return {
    asset_id: assetId,
    kind: String(kind),
    name,
    local_path: destPath,
    source_url: String(source_url),
  };
}
