// Background worker that processes queued jobs using Automatic1111 API
// Minimal single-threaded polling worker with SQLite leasing

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initDb } = require('./libs/db');
const a1111 = require('./libs/a1111');
const Workflows = require('./processors/workflows');
const ProcessorFactory = require('./processors/factory');
const createLogger = require('./libs/logger');
const log = createLogger('worker');
const db = initDb();

const POLL_MS = process.env.WORKER_POLL_MS ? Number(process.env.WORKER_POLL_MS) : 2000;

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

async function processNextJob(job) {
  const workflowKey = job.workflow || 'image_generation';
  const workflow = Workflows[workflowKey];
  const workflowStep = workflow ? workflow[job.status] : null;
  const originalWaitingState = job.status;

  if (!workflow || !workflowStep) {
    throw new Error(`Unknown workflow step: story="${workflowKey}", status="${job.status}"`);
  }

  const activeState = workflowStep.process;
  const processor = ProcessorFactory.createProcessor(activeState);

  db.updateJobStatus(job.uuid, activeState);

  try {
    const result = await processor.run(job);
    db.updateJob({
      uuid: job.uuid,
      status: workflowStep.success,
      payload: result && result.payload ? result.payload : undefined,
      retry_count: 0,
      last_retry: null,
    });
  } catch (error) {
    const failureState = workflowStep.failure || originalWaitingState;
    const incrementFailureCounter = workflowStep.incrementFailureCounter !== false;
    if (incrementFailureCounter) {
      db.incrementFailureCounter(job.uuid);
    }
    db.updateJobStatus(job.uuid, failureState);
  }
}

async function mainLoop() {
  log.info('Worker started. Poll interval:', POLL_MS, 'ms');
  // noinspection InfiniteLoopJS
    while (true) {
    try {
      await processNextJob(job);
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

async function downloadToFile(downloadUrl, destFile, headers = {}, onProgress) {
  const res = await fetch(downloadUrl, { headers });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  await fs.promises.mkdir(path.dirname(destFile), { recursive: true });
  const tmpPath = `${destFile}.part`;
  const out = fs.createWriteStream(tmpPath);

  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  const report = () => {
    if (typeof onProgress === 'function' && total > 0) {
      try { onProgress(Math.max(0, Math.min(1, received / total))); } catch (_e) { /* ignore */ }
    }
  };

  try {
    if (!res.body || !res.body.getReader) {
      // Fallback: buffer the whole body (no incremental progress)
      const buf = Buffer.from(await res.arrayBuffer());
      await new Promise((resolve, reject) => {
        out.write(buf, (err) => (err ? reject(err) : resolve()));
      });
    } else {
      const reader = res.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          received += value.length;
          await new Promise((resolve, reject) => {
            out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
          });
          report();
        }
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    await fs.promises.rename(tmpPath, destFile);
    // Final progress
    if (typeof onProgress === 'function') {
      try { onProgress(1); } catch (_e) { /* ignore */ }
    }
    return destFile;
  } catch (e) {
    try { out.destroy(); } catch (_e) { /* ignore */ }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_e) { /* ignore */ }
    throw e;
  }
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
  await downloadToFile(
    downloadUrl,
    destPath,
    { authorization: `Bearer ${API_TOKEN}` },
    (p) => {
      // Report direct 0..1 progress for asset downloads
      db.setProgress(job.uuid, p);
    }
  );

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

  // Save the first preview image next to the downloaded file
  try {
    if (images.length > 0 && images[0] && images[0].url) {
      const firstImageUrl = String(images[0].url);
      const base = path.basename(destPath, path.extname(destPath));
      const previewPath = path.join(path.dirname(destPath), `${base}.preview.jpeg`);
      await downloadToFile(firstImageUrl, previewPath);
      log.debug('Saved preview image to', previewPath);
    }
  } catch (e) {
    // Do not fail the job if preview saving fails; just warn
    log.warn('Failed to save preview image:', e && e.message ? e.message : e);
  }

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
