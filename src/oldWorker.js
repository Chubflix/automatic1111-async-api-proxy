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
        // For generation jobs we use scaled 0.1..0.9 window; for asset downloads we report 0..1 directly
        if (kind !== 'asset-download') {
            db.setProgress(job.uuid, 0.1);
        }

        let resultObj;
        let lastPolledProgress = 0; // capture progress from A1111 polling to avoid regressions

        if (kind === 'asset-download') {
            resultObj = await processAssetDownload(job);
            // Complete immediately with full progress (no 0.9 cap) and send webhook as completed
            db.completeJob(job.uuid, resultObj);
            if (job.webhookUrl) {
                const webhookPayload = {
                    uuid: job.uuid,
                    job_status: 'completed',
                    progress: 1,
                    images: [],
                    info: resultObj,
                };
                await sendWebhook(job, webhookPayload);
            }
            return; // asset-download handled fully
        } else if (kind === 'florence') {
            const fr = await florence.run(job.request);
            // fr: { text, image }
            resultObj = {
                images: fr?.image ? [fr.image] : [],
                info: fr?.text || null,
            };
        } else {
            // txt2img or img2img — poll A1111 progress while generation runs
            let running = true;
            const pollIntervalMs = 1000;
            const poller = (async () => {
                while (running) {
                    try {
                        const p = await a1111.getProgress({ skipCurrentImage: true });
                        const raw = Number(p?.progress ?? 0);
                        if (Number.isFinite(raw)) {
                            // Scale raw 0..1 into processing window [0.1, 0.9]
                            const rawClamped = Math.max(0, Math.min(1, raw));
                            const scaled = 0.1 + rawClamped * 0.8;
                            const scaledClamped = Math.max(0.1, Math.min(0.9, scaled));
                            lastPolledProgress = scaledClamped;
                            db.setProgress(job.uuid, scaledClamped);
                        }
                    } catch (e) {
                        // Do not fail the job due to polling errors
                        log.debug('Progress polling failed for job', job.uuid, e.message);
                    }
                    // Small wait between polls; allow quick exit if running was turned off
                    for (let i = 0; i < pollIntervalMs / 100; i += 1) {
                        if (!running) break;
                        // eslint-disable-next-line no-await-in-loop
                        await sleep(100);
                    }
                }
            })();

            try {
                const result = kind === 'img2img' ? await a1111.img2img(job.request) : await a1111.txt2img(job.request);
                // Automatic1111 returns { images: [base64...], info: string/json-string }
                resultObj = {
                    images: Array.isArray(result?.images) ? result.images : [],
                    info: typeof result?.info === 'string' ? result.info : (result?.info ? JSON.stringify(result.info) : null),
                };
            } finally {
                // Stop polling regardless of success/failure
                running = false;
                // Wait a brief moment to let poller exit cleanly (best-effort)
                try { await Promise.race([poller, sleep(50)]); } catch (_e) { /* ignore */ }
            }
        }

        // Move progress to webhook threshold (0.9) without regressing if polling went higher already
        db.setProgress(job.uuid, Math.max(0.9, lastPolledProgress || 0));
        if (job.webhookUrl) {
            // Move to webhook-pending state first; finalize to completed only if webhook returns 2xx
            db.markWebhookPending(job.uuid, resultObj);
            const webhookPayload = {
                uuid: job.uuid,
                job_status: 'webhook',
                progress: 0.9,
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

