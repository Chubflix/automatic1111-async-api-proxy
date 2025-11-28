import ProcessorInterface from "./processorInterface";
import {Job} from "../models/Job";
import path from "path";
import createLogger from '../libs/logger';
import fs from "fs";
import {getDbApi} from '../libs/db';
import {refreshLoras, refreshCheckpoints} from '../libs/a1111';
const log = createLogger('proc:CivitAI download');

class CivitAiDownloadProcessor implements ProcessorInterface {
  async run(job: Job) {
    const filepath = await this.processAssetDownload(job);
    return { filepath };
  }

  extractCivitaiVersionId(input: string|null|undefined) {
    const s = String(input || '');

    try {
      const u = new URL(s);
      const v = u.searchParams.get('modelVersionId');
      return v ? String(v) : null;
    } catch (_e) {
      return null;
    }
  }

  uniquePath(dir: string, filename: string) {
    const base = path.basename(filename, path.extname(filename));
    const ext = path.extname(filename);
    let candidate = path.join(dir, filename);
    let i = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${base} (${i})${ext}`);
      i += 1;
    }
    return candidate;
  }

  async downloadToFile(downloadUrl: string, destFile: string, headers = {}, onProgress = null) {
    const res = await fetch(downloadUrl, { headers });
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    }

    await fs.promises.mkdir(path.dirname(destFile), { recursive: true });
    const tmpPath = `${destFile}.part`;
    const out = fs.createWriteStream(tmpPath);

    const total = Number(res.headers.get('content-length') || 0);
    let received = 0;
    const report = () => {
      if (typeof onProgress === 'function' && total > 0) {
        try { onProgress(Math.max(0, Math.min(1, received / total))); } catch (_e) { /* ignore */ }
      }
    };

    try {
      if (!res.body || !res.body.getReader) {
        // Fallback: buffer the whole body (no incremental progress)
        const buf = Buffer.from(await res.arrayBuffer());
        await new Promise((resolve, reject) => {
          out.write(buf, (err) => (err ? reject(err) : resolve(null)));
        });
      } else {
        const reader = res.body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            received += value.length;
            await new Promise((resolve, reject) => {
              out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve(null)));
            });
            report();
          }
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve(null))));
      await fs.promises.rename(tmpPath, destFile);
      // Final progress
      if (typeof onProgress === 'function') {
        try { onProgress(1); } catch (_e) { /* ignore */ }
      }
      return destFile;
    } catch (e) {
      try { out.destroy(); } catch (_e) { /* ignore */ }
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_e) { /* ignore */ }
      throw e;
    }
  }

  async processAssetDownload(job: Job) {
    const { kind, source_url } = job.request || {};

    // Defensive: AIR tags should be normalized on the server. Reject if any slip through.
    if (String(source_url || '').toLowerCase().startsWith('urn:air:')) {
      throw new UnrecoverableError('Non CivitAI downloads are not supported at the moment');
    }

    const versionId = this.extractCivitaiVersionId(source_url);
    if (!versionId) {
      throw new Error('CivitAI version id not specified');
    }

    const API_BASE = (process.env.CIVIT_AI_ENDPOINT || '').replace(/\/$/, '');
    const API_TOKEN = process.env.CIVIT_AI_TOKEN || '';
    if (!API_BASE) {
      throw new Error('CIVIT_AI_ENDPOINT not configured');
    }
    if (!API_TOKEN) {
      throw new Error('CIVIT_AI_TOKEN not configured');
    }

    // Fetch version metadata
    const versionUrl = `${API_BASE}/model-versions/${encodeURIComponent(versionId)}`;
    log.debug('Fetching CivitAI version metadata from', versionUrl);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` };
    const resp = await fetch(versionUrl, { headers });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`CivitAI fetch failed: ${resp.status} ${resp.statusText} - ${txt.slice(0, 300)}`);
    }
    const data = await resp.json();

    // Choose file to download
    const files = Array.isArray(data.files) ? data.files : [];
    if (files.length === 0) {
      throw new Error('No downloadable files found for this CivitAI version');
    }
    const primary = files.find((f) => f.primary) || files[0];
    const fileName = primary.name || `civitai_${versionId}`;
    const downloadUrl = primary.downloadUrl || data.downloadUrl;
    if (!downloadUrl) {
      throw new Error('No downloadUrl provided by CivitAI');
    }

    const destDir = (String(kind) === 'lora') ? (process.env.LORAS_DIR || path.join(process.cwd(), 'loras'))
      : (process.env.MODELS_DIR || path.join(process.cwd(), 'models'));
    const destPath = this.uniquePath(destDir, fileName);

    // Some CivitAI downloads work with cookie auth; API usually allows Bearer
    await this.downloadToFile(
      downloadUrl,
      destPath,
      { authorization: `Bearer ${API_TOKEN}` },
      (p) => {
        getDbApi().jobs.updateProgress(job.uuid, p);
      }
    );

    // Create asset record
    const trainedWords = Array.isArray(data.trainedWords) ? data.trainedWords : [];
    const examplePrompt = trainedWords.length ? trainedWords.join(', ') : null;
    const name = (data.model && data.model.name) ? data.model.name : (data.name || null);
    const images = Array.isArray(data.images) ? data.images : [];

    const assetId = getDbApi().assets.create({
      kind: String(kind),
      name,
      source_url: String(source_url),
      example_prompt: examplePrompt,
      min: 1,
      max: 1,
      local_path: destPath,
    });

    // Save the first preview image next to the downloaded file
    try {
      if (images.length > 0 && images[0] && images[0].url) {
        const firstImageUrl = String(images[0].url);
        const base = path.basename(destPath, path.extname(destPath));
        const previewPath = path.join(path.dirname(destPath), `${base}.preview.jpeg`);
        await this.downloadToFile(firstImageUrl, previewPath);
        log.debug('Saved preview image to', previewPath);
      }
    } catch (e) {
      // Do not fail the job if preview saving fails; just warn
      log.warn('Failed to save preview image:', e && e.message ? e.message : e);
    }

    // Store images metadata
    for (const img of images) {
      const imageData = {
        asset_id: assetId,
        url: img.url,
        is_nsfw: !!img.nsfw,
        width: img.width ?? null,
        height: img.height ?? null,
        meta: img.meta ?? null,
      };
      try {
        getDbApi().assets.addImage(imageData);
      } catch (e) {
        log.error('Failed to store image metadata:', {error: e, img, imageData});
      }
    }

    // After successful download, ask Automatic1111 to refresh the relevant asset list
    try {
      if (String(kind) === 'lora') {
        await refreshLoras();
      } else {
        // treat all non-lora as checkpoints/models
        await refreshCheckpoints();
      }
    } catch (e) {
      // Do not fail the job if the refresh endpoint is unavailable; just log
      log.warn('Refresh request failed after asset download:', e && e.message ? e.message : e);
    }

    // Return a compact result object to store with the job
    return {
      asset_id: assetId,
      kind: String(kind),
      name,
      local_path: destPath,
      source_url: String(source_url),
    };
  }
}

export default CivitAiDownloadProcessor;