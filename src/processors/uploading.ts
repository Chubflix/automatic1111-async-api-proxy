class UploadProcessor implements ProcessorInterface {
  async run(job: Job) {
    // upload images to s3
    // return payload with imageUrls and info
  }
}

module.exports = UploadProcessor;
