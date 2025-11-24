// Lightweight Automatic1111 Web UI API client
// Uses Node 18+ global fetch (Node 20+/24 in this project) — no extra deps

const DEFAULT_TIMEOUT_MS = 60_000;

function getBaseUrl() {
  const base = process.env.AUTOMATIC1111_API_BASE || '';
  return base.replace(/\/$/, ''); // trim trailing slash
}

async function doFetch(path, { method = 'GET', body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = getBaseUrl();
  if (!base) throw new Error('AUTOMATIC1111_API_BASE is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  try {
    const resp = await fetch(base + path, {
      method,
      headers: {
        'accept': 'application/json',
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch (_e) { json = null; }
    if (!resp.ok) {
      const err = new Error(`Automatic1111 API error ${resp.status}`);
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    return json ?? text;
  } finally {
    clearTimeout(timeout);
  }
}

// Public API
module.exports = {
  // Generation endpoints (not used yet by server; intended for worker)
  async txt2img(payload) {
    return doFetch('/sdapi/v1/txt2img', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  },
  async img2img(payload) {
    return doFetch('/sdapi/v1/img2img', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  },

  // Metadata/listing
  async listSdModels() {
    return doFetch('/sdapi/v1/sd-models', { method: 'GET' });
  },
  async listLoras() {
    return doFetch('/sdapi/v1/loras', { method: 'GET' });
  },

  // Options passthrough
  async getOptions() {
    return doFetch('/sdapi/v1/options', { method: 'GET' });
  },
  async setOptions(payload) {
    return doFetch('/sdapi/v1/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  },
};
