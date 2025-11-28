import {Job} from "../models/Job";
import ProcessorInterface from "./processorInterface";

import createLogger from '../libs/logger';
import {getDbApi} from '../libs/db';
import a1111 from '../libs/a1111';
import {sleep} from '../libs/sleep';
const log = createLogger('proc:generate');
import crypto from 'crypto';

class ImageGenerationProcessor implements ProcessorInterface {
  generateSeed() {
    return crypto.randomInt(0, 0xFFFFFFFF); // 32-bit unsigned int (0 to 4,294,967,295)
  }

  async run(job: Job) {
    const db = getDbApi();
    // Basic progress bump to indicate work started
    try { db.jobs.updateProgress(job.uuid, 0.1); } catch (_e) {}

    const req = job.request || {} as any;

    if (req.seed === undefined || req.seed < 0) req.seed = this.generateSeed();

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
            db.jobs.updateProgress(job.uuid, scaledClamped);
          }
        } catch (e) {
          // Do not fail the job due to polling errors
          log.debug('Progress polling failed for job', job.uuid, e?.message || e);
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
      const result = job.workflow === 'img2img' ? await a1111.img2img(req) : await a1111.txt2img(req);

      const payload = {
        images: Array.isArray(result?.images) ? result.images : [],
        seed: req.seed,
        info: typeof result?.info === 'string' ? result.info : (result?.info ? JSON.stringify(result.info) : null),
      };

      try { db.jobs.updateProgress(job.uuid, 0.9); } catch (_e) {}
      return payload;
    } catch (e) {
      log.error('Generation failed for job', job.uuid, e?.message || e);
      throw e;
    } finally {
      // Stop polling regardless of success/failure
      running = false;
      // Wait a brief moment to let poller exit cleanly (best-effort)
      try { await Promise.race([poller, sleep(50)]); } catch (_e) { /* ignore */ }
    }
  }
}

export default ImageGenerationProcessor;
