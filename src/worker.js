// Background worker that processes queued jobs using Automatic1111 API
// Minimal single-threaded polling worker with SQLite leasing

require('dotenv').config();
const db = require('./db');
const a1111 = require('./a1111');

const POLL_MS = process.env.WORKER_POLL_MS ? Number(process.env.WORKER_POLL_MS) : 2000;
const ENABLE_PROGRESS_TICKS = true;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chooseEndpoint(request) {
  // If init_images present/useful, treat as img2img; otherwise txt2img
  if (request && Array.isArray(request.init_images) && request.init_images.length > 0) return 'img2img';
  return 'txt2img';
}

async function sendWebhook(job, payload) {
  if (!job.webhookUrl) return;
  try {
    const headers = { 'content-type': 'application/json' };
    if (job.webhookKey) headers['x-webhook-key'] = job.webhookKey;
    await fetch(job.webhookUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Webhook delivery failed for', job.uuid, e.message);
  }
}

async function processOne(job) {
  // Indicate we started
  db.setProgress(job.uuid, 0.01);

  const kind = chooseEndpoint(job.request);
  try {
    if (ENABLE_PROGRESS_TICKS) db.setProgress(job.uuid, 0.1);

    const result = kind === 'img2img' ? await a1111.img2img(job.request) : await a1111.txt2img(job.request);

    if (ENABLE_PROGRESS_TICKS) db.setProgress(job.uuid, 0.9);

    // Automatic1111 returns { images: [base64...], info: string/json-string }
    const resultObj = {
      images: Array.isArray(result?.images) ? result.images : [],
      info: typeof result?.info === 'string' ? result.info : (result?.info ? JSON.stringify(result.info) : null),
    };
    db.completeJob(job.uuid, resultObj);

    // Build webhook payload
    const webhookPayload = {
      uuid: job.uuid,
      job_status: 'completed',
      progress: 1,
      images: resultObj.images,
      info: resultObj.info,
    };
    await sendWebhook(job, webhookPayload);
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
  // eslint-disable-next-line no-console
  console.log('Worker started. Poll interval:', POLL_MS, 'ms');
  while (true) {
    try {
      const job = db.leaseNextQueuedJob();
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }
      // eslint-disable-next-line no-console
      console.log('Processing job', job.uuid);
      await processOne(job);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Worker loop error:', e.message);
      await sleep(POLL_MS);
    }
  }
}

// Validate config
if (!process.env.AUTOMATIC1111_API_BASE) {
  // eslint-disable-next-line no-console
  console.warn('Warning: AUTOMATIC1111_API_BASE is not set. Worker cannot process jobs.');
}

mainLoop();
