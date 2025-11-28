import createLogger from './logger';

const log = createLogger('lib:civitai');

// Type definitions for CivitAI API responses
export interface CivitAIFile {
  primary?: boolean;
  name?: string;
  downloadUrl?: string;
}

export interface CivitAIImage {
  url: string;
  nsfw?: boolean;
  width?: number;
  height?: number;
  meta?: unknown;
}

export interface CivitAIVersion {
  files?: CivitAIFile[];
  downloadUrl?: string;
  trainedWords?: string[];
  name?: string;
  images?: CivitAIImage[];
  model?: {
    name?: string;
  };
}

export interface CivitAIConfig {
  apiBase: string;
  apiToken: string;
}

/**
 * Gets CivitAI configuration from environment variables
 * @throws {Error} If required environment variables are not set
 */
export function getCivitAIConfig(): CivitAIConfig {
  const apiBase = (process.env.CIVIT_AI_ENDPOINT || '').replace(/\/$/, '');
  const apiToken = process.env.CIVIT_AI_TOKEN || '';

  if (!apiBase) {
    throw new Error('CIVIT_AI_ENDPOINT not configured');
  }
  if (!apiToken) {
    throw new Error('CIVIT_AI_TOKEN not configured');
  }

  return {
    apiBase,
    apiToken,
  };
}

/**
 * Extracts the CivitAI model version ID from a URL or string
 * @param input - URL string containing modelVersionId parameter
 * @returns The version ID or null if not found
 */
export function extractCivitaiVersionId(input: string | null | undefined): string | null {
  const inputString = String(input || '');

  try {
    const url = new URL(inputString);
    const versionId = url.searchParams.get('modelVersionId');
    return versionId ? String(versionId) : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Fetches version metadata from CivitAI API
 * @param versionId - The CivitAI model version ID
 * @param config - CivitAI API configuration (optional, will use env vars if not provided)
 * @returns Version metadata from CivitAI
 * @throws {Error} If the API request fails
 */
export async function fetchCivitAIVersion(
  versionId: string,
  config?: CivitAIConfig
): Promise<CivitAIVersion> {
  const apiConfig = config || getCivitAIConfig();
  const versionUrl = `${apiConfig.apiBase}/model-versions/${encodeURIComponent(versionId)}`;

  log.debug('Fetching CivitAI version metadata from', versionUrl);

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiConfig.apiToken}`,
  };

  const response = await fetch(versionUrl, { headers });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `CivitAI fetch failed: ${response.status} ${response.statusText} - ${errorText.slice(0, 300)}`
    );
  }

  return await response.json();
}

/**
 * Selects the primary file from a CivitAI version response
 * @param versionData - The CivitAI version metadata
 * @param versionId - The version ID (used for fallback filename)
 * @returns Object containing fileName and downloadUrl
 * @throws {Error} If no files are available or no download URL is found
 */
export function selectPrimaryFile(
  versionData: CivitAIVersion,
  versionId: string
): { fileName: string; downloadUrl: string } {
  const files = Array.isArray(versionData.files) ? versionData.files : [];

  if (files.length === 0) {
    throw new Error('No downloadable files found for this CivitAI version');
  }

  const primaryFile = files.find((file) => file.primary) || files[0];
  const fileName = primaryFile.name || `civitai_${versionId}`;
  const downloadUrl = primaryFile.downloadUrl || versionData.downloadUrl;

  if (!downloadUrl) {
    throw new Error('No downloadUrl provided by CivitAI');
  }

  return { fileName, downloadUrl };
}

/**
 * Extracts asset metadata from CivitAI version data
 * @param versionData - The CivitAI version metadata
 * @returns Object containing asset name, example prompt, and images
 */
export function extractAssetMetadata(versionData: CivitAIVersion): {
  name: string | null;
  examplePrompt: string | null;
  images: CivitAIImage[];
} {
  const trainedWords = Array.isArray(versionData.trainedWords)
    ? versionData.trainedWords
    : [];
  const examplePrompt = trainedWords.length ? trainedWords.join(', ') : null;
  const name = versionData.model?.name || versionData.name || null;
  const images = Array.isArray(versionData.images) ? versionData.images : [];

  return {
    name,
    examplePrompt,
    images,
  };
}
