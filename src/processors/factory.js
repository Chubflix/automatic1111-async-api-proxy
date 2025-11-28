const ImageGenerationProcessor = require('./imageGeneration');
const UploadProcessor = require('./uploading');

class ProcessorFactory {
  static createProcessor(activeState) {
    switch (activeState) {
      case 'generating':
        return new ImageGenerationProcessor();
      case 'uploading':
        return new UploadProcessor();
      // Future processors: tagging, downloading-lora, sending-webhook
      default:
        throw new Error(`Unknown active state: ${activeState}`);
    }
  }
}

module.exports = ProcessorFactory;
