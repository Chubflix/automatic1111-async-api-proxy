const db = require('../libs/db');

async function sendWebhook(job, payload) {
  if (!job.webhookUrl) return false;
  const headers = { 'content-type': 'application/json' };
  if (job.webhookKey) headers['x-webhook-key'] = job.webhookKey;
  const resp = await fetch(job.webhookUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
  return !!resp && resp.ok;
}

class UploadProcessor {
  async run(job) {
    // Expect previous step to have produced images/info in job.result or provided in job
    const result = job.result || {};
    const images = Array.isArray(result.images) ? result.images : [];
    const info = result.info ?? null;

    // Mark webhook pending, attempt delivery, complete on success
    db.markWebhookPending(job.uuid, { images, info });
    const ok = await sendWebhook(job, {
      uuid: job.uuid,
      job_status: 'webhook',
      progress: 0.9,
      images,
      info,
    });
    if (ok) {
      db.completeJob(job.uuid, { images, info });
    }
    // No payload changes required for orchestrator
    return { payload: { images, info } };
  }
}

module.exports = UploadProcessor;
