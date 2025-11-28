import ProcessorInterface from "./processorInterface";
import ImageGenerationProcessor from "./imageGeneration";
import WebhookProcessor from "./webhook";
import UploadProcessor from "./uploading";

class ProcessorFactory {
  static createProcessor(activeState: string): ProcessorInterface {
    switch (activeState) {
      case 'generating':
        return new ImageGenerationProcessor();
      case 'uploading':
        return new UploadProcessor();
      case 'webhook':
        return new WebhookProcessor();
      default:
        throw new Error(`Unknown active state: ${activeState}`);
    }
  }
}

module.exports = ProcessorFactory;
