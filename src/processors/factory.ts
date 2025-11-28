import ProcessorInterface from "./processorInterface";
import ImageGenerationProcessor from "./imageGeneration";
import WebhookProcessor from "./webhook";
import UploadProcessor from "./uploading";
import NoopProcessor from "./noop";

class ProcessorFactory {
  static createProcessor(activeState: string): ProcessorInterface {
    switch (activeState) {
      case 'noop':
        return new NoopProcessor();
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
