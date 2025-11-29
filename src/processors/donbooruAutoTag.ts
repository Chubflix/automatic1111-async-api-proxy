import ProcessorInterface from "./processorInterface";
import {Job} from "../models/Job";
import createLogger from '../libs/logger';

const log = createLogger('proc:donbooru-autotag');

interface AutoTagResponse {
  filename: string;
  tags: Record<string, number>;
}

class DonbooruAutoTagProcessor implements ProcessorInterface {
  async run(job: Job) {
    const apiEndpoint = process.env.DONBOORU_AUTOTAG_ENDPOINT || 'https://booru.svc.cklio.com/evaluate';

    // Get existing result data
    const existingResult = (job.result || {} as any);
    const images = Array.isArray(existingResult.images) ? existingResult.images : [];

    if (images.length === 0) {
      log.warn('No images found in job result for auto-tagging', job.uuid);
      return {
        ...existingResult,
        tags: {},
      };
    }

    try {
      // For now, we'll tag the first image. You can modify this to tag all images if needed.
      const firstImage = images[0];

      // Convert base64 to buffer
      const imageBuffer = Buffer.from(firstImage, 'base64');

      // Create form data
      const formData = new FormData();
      // Create a File object from the buffer
      const file = new File([imageBuffer], 'image.png', { type: 'image/png' });
      formData.append('file', file);
      formData.append('format', 'json');

      // Send request to auto-tag API
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Auto-tag API failed: ${response.status} ${response.statusText}`);
      }

      const responseData: AutoTagResponse[] = await response.json();

      // Extract tags from first result
      const tags = responseData[0]?.tags || {};

      log.debug('Auto-tagging completed', { jobUuid: job.uuid, tagCount: Object.keys(tags).length });

      // Return merged result with tags
      return {
        ...existingResult,
        tags,
      };
    } catch (error) {
      const errorMessage = error && typeof error === 'object' && 'message' in error
        ? error.message
        : String(error);
      log.error('Auto-tagging failed for job', job.uuid, errorMessage);

      // Return existing result without tags on error
      return {
        ...existingResult,
        tags: {},
      };
    }
  }
}

export default DonbooruAutoTagProcessor;
