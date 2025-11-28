// Minimal client for a Florence-2 Gradio backend
// Calls two endpoints in sequence as requested:
// 1) POST /call/update_task_dropdown with { data: ["Single task" | "Cascaded task"] }
// 2) POST /call/process_image with {
//      data: [ { path: imageUrl }, taskName, prompt, "microsoft/Florence-2-large" ]
//    }
// Returns a normalized object: { text: string, image: string|null }

const DEFAULT_TIMEOUT_MS = 60_000;

function getBaseUrl() {
  const base = process.env.FLORENCE_API_BASE || '';
  return base.replace(/\/$/, '');
}

async function doFetch(path, { method = 'POST', body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = getBaseUrl();
  if (!base) throw new Error('FLORENCE_API_BASE is not configured');

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
      const err = new Error(`Florence API error ${resp.status}`);
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    return json ?? text;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTuple(resp) {
  // Gradio typically returns { data: [...] }
  let arr = Array.isArray(resp) ? resp : Array.isArray(resp?.data) ? resp.data : null;
  if (!arr) return { text: null, image: null };
  const first = arr[0] ?? null;
  const second = arr[1] ?? null;
  const text = typeof first === 'string' ? first : (first?.label || null);
  const image = typeof second === 'string' ? second : (second?.image || null);
  return { text, image };
}

module.exports = {
  async run({ imageUrl, mode, task, prompt }) {
    const theMode = (mode || '').trim() || (task && task.toLowerCase().includes('caption') ? 'Cascaded task' : 'Single task');
    const taskName = (task || '').trim();
    const userPrompt = prompt == null ? '' : String(prompt);

    // 1) update task dropdown (ignore output)
    await doFetch('/call/update_task_dropdown', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [theMode] }),
    });

    // 2) process_image
    const payload = {
      data: [
        { path: String(imageUrl || '') },
        taskName,
        userPrompt,
        'microsoft/Florence-2-large',
      ],
    };
    const resp = await doFetch('/call/process_image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return normalizeTuple(resp);
  },
};
