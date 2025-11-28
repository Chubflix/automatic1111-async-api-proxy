import ProcessorInterface from "./processorInterface";
import {Job} from "../models/Job";
import path from "path";
import createLogger from '../libs/logger';
import fs from "fs";
import {getDbApi} from '../libs/db';
import {refreshLoras, refreshCheckpoints} from '../libs/a1111';
import UnrecoverableError from "../errors/unrecoverable-error";
import {
  type CivitAIVersion,
  getCivitAIConfig,
  extractCivitaiVersionId,
  fetchCivitAIVersion,
  selectPrimaryFile,
  extractAssetMetadata,
} from '../libs/civitai';

const log = createLogger('proc:CivitAI download');

interface AssetRecord {
  asset_id: number;
  kind: string;
  name: string | null;
  local_path: string;
  source_url: string;
}

interface DownloadProgress {
  (progress: number): void;
}

// Constants
const ASSET_KIND = {
  LORA: 'lora',
  MODEL: 'model',
} as const;

const URN_PREFIX = 'urn:air:';

class CivitAiDownloadProcessor implements ProcessorInterface {
  async run(job: Job) {
    const filepath = await this.processAssetDownload(job);
    return { filepath };
  }

  private getDirectoryConfig() {
    return {
      lorasDir: process.env.LORAS_DIR || path.join(process.cwd(), 'loras'),
      modelsDir: process.env.MODELS_DIR || path.join(process.cwd(), 'models'),
    };
  }

  uniquePath(directory: string, filename: string): string {
    const baseName = path.basename(filename, path.extname(filename));
    const extension = path.extname(filename);
    let candidatePath = path.join(directory, filename);
    let counter = 1;

    while (fs.existsSync(candidatePath)) {
      candidatePath = path.join(directory, `${baseName} (${counter})${extension}`);
      counter += 1;
    }

    return candidatePath;
  }

  async downloadToFile(
    downloadUrl: string,
    destinationFile: string,
    headers: Record<string, string> = {},
    onProgress: DownloadProgress | null = null
  ): Promise<string> {
    const response = await fetch(downloadUrl, { headers });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    await fs.promises.mkdir(path.dirname(destinationFile), { recursive: true });
    const tempPath = `${destinationFile}.part`;
    const outputStream = fs.createWriteStream(tempPath);

    const totalBytes = Number(response.headers.get('content-length') || 0);
    let receivedBytes = 0;

    const reportProgress = () => {
      if (typeof onProgress === 'function' && totalBytes > 0) {
        try {
          const progress = Math.max(0, Math.min(1, receivedBytes / totalBytes));
          onProgress(progress);
        } catch (_error) {
          // Ignore progress callback errors
        }
      }
    };

    try {
      if (!response.body || !response.body.getReader) {
        // Fallback: buffer the whole body (no incremental progress)
        const buffer = Buffer.from(await response.arrayBuffer());
        await new Promise<void>((resolve, reject) => {
          outputStream.write(buffer, (error) => (error ? reject(error) : resolve()));
        });
      } else {
        const reader = response.body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value && value.length) {
            receivedBytes += value.length;
            await new Promise<void>((resolve, reject) => {
              outputStream.write(Buffer.from(value), (error) => (error ? reject(error) : resolve()));
            });
            reportProgress();
          }
        }
      }

      await new Promise<void>((resolve, reject) =>
        outputStream.end((error) => (error ? reject(error) : resolve()))
      );

      await fs.promises.rename(tempPath, destinationFile);

      // Final progress update
      if (typeof onProgress === 'function') {
        try {
          onProgress(1);
        } catch (_error) {
          // Ignore progress callback errors
        }
      }

      return destinationFile;
    } catch (error) {
      try {
        outputStream.destroy();
      } catch (_error) {
        // Ignore cleanup errors
      }

      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (_error) {
        // Ignore cleanup errors
      }

      throw error;
    }
  }

  private getDestinationPath(assetKind: string, fileName: string, directoryConfig: ReturnType<typeof this.getDirectoryConfig>): string {
    const destinationDirectory = assetKind === ASSET_KIND.LORA
      ? directoryConfig.lorasDir
      : directoryConfig.modelsDir;

    return this.uniquePath(destinationDirectory, fileName);
  }

  private async savePreviewImage(
    versionData: CivitAIVersion,
    assetPath: string
  ): Promise<void> {
    const images = Array.isArray(versionData.images) ? versionData.images : [];

    if (images.length === 0 || !images[0]?.url) {
      return;
    }

    try {
      const firstImageUrl = String(images[0].url);
      const baseFileName = path.basename(assetPath, path.extname(assetPath));
      const previewPath = path.join(path.dirname(assetPath), `${baseFileName}.preview.jpeg`);

      await this.downloadToFile(firstImageUrl, previewPath);
      log.debug('Saved preview image to', previewPath);
    } catch (error) {
      // Do not fail the job if preview saving fails; just warn
      const errorMessage = error && typeof error === 'object' && 'message' in error
        ? error.message
        : String(error);
      log.warn('Failed to save preview image:', errorMessage);
    }
  }

  private saveImageMetadata(versionData: CivitAIVersion, assetId: number): void {
    const images = Array.isArray(versionData.images) ? versionData.images : [];

    for (const image of images) {
      const imageData = {
        asset_id: assetId,
        url: image.url,
        is_nsfw: !!image.nsfw,
        width: image.width ?? null,
        height: image.height ?? null,
        meta: image.meta ?? null,
      };

      try {
        getDbApi().assets.addImage(assetId, imageData);
      } catch (error) {
        log.error('Failed to store image metadata:', { error, image, imageData });
      }
    }
  }

  private createAssetRecord(
    assetKind: string,
    versionData: CivitAIVersion,
    sourceUrl: string,
    destinationPath: string
  ): number {
    const { name, examplePrompt } = extractAssetMetadata(versionData);

    return getDbApi().assets.create({
      kind: assetKind,
      name,
      source_url: sourceUrl,
      example_prompt: examplePrompt,
      min: 1,
      max: 1,
      local_path: destinationPath,
    });
  }

  private async refreshA1111Assets(assetKind: string): Promise<void> {
    try {
      if (assetKind === ASSET_KIND.LORA) {
        await refreshLoras();
      } else {
        // Treat all non-lora as checkpoints/models
        await refreshCheckpoints();
      }
    } catch (error) {
      // Do not fail the job if the refresh endpoint is unavailable; just log
      const errorMessage = error && typeof error === 'object' && 'message' in error
        ? error.message
        : String(error);
      log.warn('Refresh request failed after asset download:', errorMessage);
    }
  }

  async processAssetDownload(job: Job): Promise<AssetRecord> {
    const { kind, source_url } = job.request || {};
    const assetKind = String(kind);
    const sourceUrl = String(source_url);

    // Defensive: AIR tags should be normalized on the server. Reject if any slip through.
    if (sourceUrl.toLowerCase().startsWith(URN_PREFIX)) {
      throw new UnrecoverableError('Non CivitAI downloads are not supported at the moment');
    }

    const versionId = extractCivitaiVersionId(source_url);
    if (!versionId) {
      throw new UnrecoverableError('CivitAI version id not specified');
    }

    const civitaiConfig = getCivitAIConfig();
    const directoryConfig = this.getDirectoryConfig();

    // Fetch version metadata from CivitAI
    const versionData = await fetchCivitAIVersion(versionId, civitaiConfig);

    // Select the primary file to download (wrap in UnrecoverableError if it fails)
    let fileName: string;
    let downloadUrl: string;
    try {
      const result = selectPrimaryFile(versionData, versionId);
      fileName = result.fileName;
      downloadUrl = result.downloadUrl;
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : 'Failed to select primary file';
      throw new UnrecoverableError(message);
    }

    // Determine destination path
    const destinationPath = this.getDestinationPath(assetKind, fileName, directoryConfig);

    // Download the file
    await this.downloadToFile(
      downloadUrl,
      destinationPath,
      { authorization: `Bearer ${civitaiConfig.apiToken}` },
      (progress) => {
        getDbApi().jobs.updateProgress(job.uuid, progress);
      }
    );

    // Create asset record in database
    const assetId = this.createAssetRecord(assetKind, versionData, sourceUrl, destinationPath);

    // Save preview image (non-blocking)
    await this.savePreviewImage(versionData, destinationPath);

    // Save image metadata
    this.saveImageMetadata(versionData, assetId);

    // Refresh A1111 asset list
    await this.refreshA1111Assets(assetKind);

    // Return compact result object to store with the job
    const { name } = extractAssetMetadata(versionData);
    return {
      asset_id: assetId,
      kind: assetKind,
      name,
      local_path: destinationPath,
      source_url: sourceUrl,
    };
  }
}

export default CivitAiDownloadProcessor;
