import ProcessorInterface from "./processorInterface";
import {Job} from "../models/Job";

class WebhookProcessor implements ProcessorInterface {
  async run(job: Job) {
    if (!job.webhookUrl) return job.result || {};
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (job.webhookKey) headers['x-webhook-key'] = job.webhookKey as string;
      const payload = {
        uuid: job.uuid,
        job_status: 'completed',
        progress: 1,
        images: (job.result && (job.result as any).images) || [],
        seed: (job.result && (job.result as any).seed) || null,
        info: (job.result && (job.result as any).info) || null,
        tags: (job.result && (job.result as any).tags) || null,
      };
      await fetch(job.webhookUrl as string, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (_e) {
      // ignore webhook delivery failures for now
    }
    return job.result || {};
  }
}

export default WebhookProcessor;