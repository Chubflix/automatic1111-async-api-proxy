import {Job} from "../models/Job";
import ProcessorInterface from "./processorInterface";

import createLogger from '../libs/logger';
import {getDbApi} from '../libs/db';
import a1111 from '../libs/a1111';
const log = createLogger('proc:generate');

class ImageGenerationProcessor implements ProcessorInterface {
  async run(job: Job) {
    const db = getDbApi();
    // Basic progress bump to indicate work started
    try { db.jobs.updateProgress(job.uuid, 0.1); } catch (_e) {}

    const req = job.request || {} as any;

    try {
      const result = job.workflow === 'img2img' ? await a1111.img2img(req) : await a1111.txt2img(req);

      const payload = {
        images: Array.isArray(result?.images) ? result.images : [],
        info: typeof result?.info === 'string' ? result.info : (result?.info ? JSON.stringify(result.info) : null),
      };

      try { db.jobs.updateProgress(job.uuid, 0.9); } catch (_e) {}
      return payload;
    } catch (e) {
      log.error('Generation failed for job', job.uuid, e?.message || e);
      throw e;
    }
  }
}

export default ImageGenerationProcessor;
