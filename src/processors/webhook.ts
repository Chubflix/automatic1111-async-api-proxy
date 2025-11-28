class WebhookProcessor implements ProcessorInterface {
  async run(job: Job) {
    // send webhook to a1111 with payload from job
    // return empty payload
    return {}
  }
}

module.exports = WebhookProcessor;
