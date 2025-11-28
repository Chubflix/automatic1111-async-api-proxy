const a1111 = require('../libs/a1111');
const { getDbApi } = require('../libs/db');
const createLogger = require('../libs/logger');
const log = createLogger('proc:generate');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function chooseEndpoint(request) {
  if (request?.type === 'florence') return 'florence';
  if (request && Array.isArray(request.init_images) && request.init_images.length > 0) return 'img2img';
  return 'txt2img';
}

class ImageGenerationProcessor {
  async run(job) {
    const request = job.request || {};
    const kind = chooseEndpoint(request);

    // mark minimal starting progress
    getDbApi().setProgress(job.uuid, 0.05);

    if (kind === 'florence') {
      const fr = await florence.run(request);
      return {
        payload: {
          images: fr?.image ? [fr.image] : [],
          info: fr?.text || null,
        },
      };
    }

    // Poll Automatic1111 progress while generating
    let running = true;
    const pollIntervalMs = 1000;
    let lastPolledProgress = 0.1;
    const poller = (async () => {
      while (running) {
        try {
          const p = await a1111.getProgress({ skipCurrentImage: true });
          const raw = Number(p?.progress ?? 0);
          if (Number.isFinite(raw)) {
            const rawClamped = Math.max(0, Math.min(1, raw));
            const scaled = 0.1 + rawClamped * 0.8; // 0.1..0.9
            const scaledClamped = Math.max(0.1, Math.min(0.9, scaled));
            lastPolledProgress = scaledClamped;
            db.setProgress(job.uuid, scaledClamped);
          }
        } catch (e) {
          log.debug('Progress polling failed for job', job.uuid, e.message);
        }
        for (let i = 0; i < pollIntervalMs / 100; i += 1) {
          if (!running) break;
          // eslint-disable-next-line no-await-in-loop
          await sleep(100);
        }
      }
    })();

    try {
      const result = kind === 'img2img' ? await a1111.img2img(request) : await a1111.txt2img(request);
      const payload = {
        images: Array.isArray(result?.images) ? result.images : [],
        info: typeof result?.info === 'string' ? result.info : (result?.info ? JSON.stringify(result.info) : null),
      };
      // set to webhook threshold without regressing if polling went higher
      db.setProgress(job.uuid, Math.max(0.9, lastPolledProgress || 0.9));
      return { payload };
    } finally {
      running = false;
    }
  }
}

module.exports = ImageGenerationProcessor;
