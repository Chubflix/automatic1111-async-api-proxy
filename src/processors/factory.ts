import ProcessorInterface from "./processorInterface";
import ImageGenerationProcessor from "./imageGeneration";
import WebhookProcessor from "./webhook";
import UploadProcessor from "./uploading";
import NoopProcessor from "./noop";
import CivitAiDownloadProcessor from "./civitaiDownload";
import DonbooruAutoTagProcessor from "./donbooruAutoTag";

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
      case 'civitai-download':
        return new CivitAiDownloadProcessor();
      case 'donbooru-autotag':
        return new DonbooruAutoTagProcessor();
      default:
        throw new Error(`Unknown active state: ${activeState}`);
    }
  }
}

module.exports = ProcessorFactory;
