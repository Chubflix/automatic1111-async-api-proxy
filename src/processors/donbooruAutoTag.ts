import ProcessorInterface from "./processorInterface";
import {Job} from "../models/Job";
import createLogger from '../libs/logger';
import {sleep} from '../libs/sleep';

const log = createLogger('proc:donbooru-autotag');

interface AutoTagResponse {
  filename: string;
  tags: Record<string, number>;
}

class DonbooruAutoTagProcessor implements ProcessorInterface {
  // Fetch with retry mechanism and timeout
  async fetchWithRetry(url: string, options: RequestInit, maxRetries = 3, timeoutMs = 25_000): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        log.warn(`Auto-tag API request failed (attempt ${attempt}/${maxRetries}): ${lastError.message}`);

        // If this is not the last attempt, wait before retrying
        if (attempt < maxRetries) {
          await sleep(1000); // Wait 1 second between retries
        }
      }
    }

    // If we've exhausted all retries, throw the last error
    throw lastError || new Error('All retry attempts failed');
  }

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

      // Send request to auto-tag API with retry and timeout
      const response = await this.fetchWithRetry(apiEndpoint, {
        method: 'POST',
        body: formData,
      }, 3, 20_000);

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
