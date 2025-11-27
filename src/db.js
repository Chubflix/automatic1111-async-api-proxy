const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Determine DB path
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'jobs.db');

// Ensure directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Could not create DB directory:', dir, e.message);
  }
}

const db = new Database(DB_PATH);

// Pragmas for better reliability in single-process usage
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Detect existing schema and migrate if needed, then ensure target schema exists
function getCurrentColumns() {
  try {
    const rows = db.prepare("PRAGMA table_info('jobs')").all();
    return rows.map((r) => r.name);
  } catch (_e) {
    return [];
  }
}

function ensureTargetSchema() {
  // Target schema requested by user:
  // jobs(uuid TEXT PRIMARY KEY, status TEXT NOT NULL, progress REAL NOT NULL,
  //      request TEXT NOT NULL, result TEXT, error TEXT, webhookUrl TEXT, webhookKey TEXT)
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      uuid TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      progress REAL NOT NULL,
      request TEXT NOT NULL,
      result TEXT,
      error TEXT,
      webhookUrl TEXT,
      webhookKey TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

    -- Assets table for models and LoRAs downloads/registry
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('model','lora')),
      name TEXT,
      source_url TEXT NOT NULL,
      example_prompt TEXT,
      min REAL NOT NULL DEFAULT 1,
      max REAL NOT NULL DEFAULT 1,
      local_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind);
    -- (no status index; assets table is not used as a queue)

    -- Images for assets (multiple images per asset)
    CREATE TABLE IF NOT EXISTS assets_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id TEXT NOT NULL,
      url TEXT NOT NULL,
      is_nsfw INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      meta TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_assets_images_asset_id ON assets_images(asset_id);
  `);
}

function migrateIfLegacy() {
  const cols = getCurrentColumns();
  if (cols.length === 0) {
    // No table — create fresh
    ensureTargetSchema();
    return;
  }
  const isLegacy = cols.includes('job_status') || cols.includes('params') || cols.includes('kind');
  const isTarget = cols.includes('status') && cols.includes('request');
  if (isTarget) {
    // Already on target
    ensureTargetSchema();
    return;
  }
  if (!isLegacy) {
    // Unknown schema — do not drop, but ensure indices for target if compatible
    ensureTargetSchema();
    return;
  }

  // Perform migration from legacy schema to target
  const deserialize = (text, fallback) => {
    if (text == null) return fallback;
    try { return JSON.parse(text); } catch (_e) { return fallback; }
  };

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs_new (
        uuid TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        progress REAL NOT NULL,
        request TEXT NOT NULL,
        result TEXT,
        error TEXT,
        webhookUrl TEXT,
        webhookKey TEXT
      );
    `);

    const selectAll = db.prepare('SELECT * FROM jobs');
    const insertNew = db.prepare(`
      INSERT INTO jobs_new (uuid, status, progress, request, result, error, webhookUrl, webhookKey)
      VALUES (@uuid, @status, @progress, @request, @result, @error, @webhookUrl, @webhookKey)
    `);

    for (const r of selectAll.iterate()) {
      // Map legacy row to new row
      const legacyParams = deserialize(r.params, {});
      // Remove webhook fields from request body if present
      const reqCopy = { ...legacyParams };
      if (Object.prototype.hasOwnProperty.call(reqCopy, 'webhookUrl')) delete reqCopy.webhookUrl;
      if (Object.prototype.hasOwnProperty.call(reqCopy, 'webhookKey')) delete reqCopy.webhookKey;

      const images = deserialize(r.images, []);
      const resultObj = { images };
      if (r.info != null) resultObj.info = r.info;

      const row = {
        uuid: r.uuid,
        status: r.job_status,
        progress: Number(r.progress || 0),
        request: JSON.stringify(reqCopy || {}),
        result: JSON.stringify(resultObj),
        error: r.job_status === 'error' ? (r.info || null) : null,
        webhookUrl: r.webhookUrl ?? null,
        webhookKey: r.webhookKey ?? null,
      };
      insertNew.run(row);
    }

    db.exec('DROP TABLE jobs');
    db.exec('ALTER TABLE jobs_new RENAME TO jobs');
    db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    // eslint-disable-next-line no-console
    console.error('Migration to target schema failed:', e.message);
    throw e;
  }
}

migrateIfLegacy();
ensureTargetSchema();

// Helpers to (de)serialize JSON fields
function serialize(val) {
  return JSON.stringify(val == null ? null : val);
}
function deserialize(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch (_e) {
    return fallback;
  }
}

// Helpers for assets_images table
const insertAssetImageStmt = db.prepare(`
  INSERT INTO assets_images (asset_id, url, is_nsfw, width, height, meta, created_at)
  VALUES (@asset_id, @url, @is_nsfw, @width, @height, @meta, @created_at)
`);

const listAssetImagesStmt = db.prepare(`
  SELECT asset_id, url, is_nsfw, width, height, meta FROM assets_images
  WHERE asset_id = ?
  ORDER BY id ASC
`);

const insertJobStmt = db.prepare(`
  INSERT INTO jobs (uuid, status, progress, request, result, error, webhookUrl, webhookKey)
  VALUES (@uuid, @status, @progress, @request, @result, @error, @webhookUrl, @webhookKey)
`);

const listSummariesStmt = db.prepare(`
  SELECT uuid, status, progress FROM jobs ORDER BY rowid DESC
`);

// Active jobs are those that are not finished yet: queued, processing, or awaiting webhook confirmation
const listActiveSummariesStmt = db.prepare(`
  SELECT uuid, status, progress FROM jobs
  WHERE status IN ('queued','processing','webhook')
  ORDER BY rowid DESC
`);

// Recent error jobs (most recent first)
const listErrorsStmt = db.prepare(`
  SELECT uuid, error FROM jobs
  WHERE status = 'error' AND error IS NOT NULL
  ORDER BY rowid DESC
  LIMIT @limit
`);

const getJobStmt = db.prepare(`
  SELECT * FROM jobs WHERE uuid = ?
`);

const updateStatusStmt = db.prepare(`
  UPDATE jobs SET status = @status WHERE uuid = @uuid
`);

module.exports = {
  // job: { uuid, status, progress, request(obj), result(obj|null), error(string|null), webhookUrl, webhookKey }
  createJob(job) {
    const row = {
      uuid: job.uuid,
      status: job.status,
      progress: Number(job.progress || 0),
      request: serialize(job.request || {}),
      result: job.result == null ? null : serialize(job.result),
      error: job.error ?? null,
      webhookUrl: job.webhookUrl ?? null,
      webhookKey: job.webhookKey ?? null,
    };
    insertJobStmt.run(row);
    return job.uuid;
  },

  listJobsSummary() {
    return listSummariesStmt.all().map((r) => ({
      uuid: r.uuid,
      status: r.status,
      progress: Number(r.progress || 0),
    }));
  },

  // Recent job errors, default limit 50
  listRecentErrors(limit = 50) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    return listErrorsStmt.all({ limit: lim }).map((r) => ({ uuid: r.uuid, error: r.error }));
  },

  // Only queued or processing jobs
  listActiveJobsSummary() {
    return listActiveSummariesStmt.all().map((r) => ({
      uuid: r.uuid,
      status: r.status,
      progress: Number(r.progress || 0),
    }));
  },

  getJob(uuid) {
    const r = getJobStmt.get(uuid);
    if (!r) return null;
    return {
      uuid: r.uuid,
      status: r.status,
      progress: Number(r.progress || 0),
      request: deserialize(r.request, {}),
      result: deserialize(r.result, null),
      error: r.error ?? null,
      webhookUrl: r.webhookUrl ?? null,
      webhookKey: r.webhookKey ?? null,
    };
  },

  cancelJob(uuid) {
    const job = this.getJob(uuid);
    if (!job) return false;
    if (job.status !== 'queued' && job.status !== 'processing' && job.status !== 'webhook') return false;
    updateStatusStmt.run({ uuid, status: 'canceled' });
    return true;
  },

  // Atomically lease the next queued job and mark it processing. Returns full job or null.
  leaseNextQueuedJob() {
    let leased = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY rowid ASC LIMIT 1").get();
      if (row) {
        db.prepare("UPDATE jobs SET status='processing' WHERE uuid = ?").run(row.uuid);
        leased = {
          uuid: row.uuid,
          status: 'processing',
          progress: Number(row.progress || 0),
          request: deserialize(row.request, {}),
          result: deserialize(row.result, null),
          error: row.error ?? null,
          webhookUrl: row.webhookUrl ?? null,
          webhookKey: row.webhookKey ?? null,
        };
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return leased;
  },

  setProgress(uuid, progress) {
    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    db.prepare('UPDATE jobs SET progress=? WHERE uuid=?').run(p, uuid);
  },

  completeJob(uuid, resultObj) {
    db.prepare("UPDATE jobs SET status='completed', progress=1, result=?, error=NULL WHERE uuid=?")
      .run(serialize(resultObj || null), uuid);
  },

  // Set job to webhook pending state with final result saved; completion will be confirmed by webhook 2xx
  markWebhookPending(uuid, resultObj) {
    // Keep progress capped at 0.9 while waiting for webhook confirmation
    db.prepare("UPDATE jobs SET status='webhook', progress=0.9, result=?, error=NULL WHERE uuid=?")
      .run(serialize(resultObj || null), uuid);
  },

  failJob(uuid, message) {
    db.prepare("UPDATE jobs SET status='error', error=? WHERE uuid=?").run(message || 'Unknown error', uuid);
  },

  // Public listing of active jobs: processing (top), then queued, then webhook (bottom)
  // Returns minimal fields: uuid, status, progress (0..1)
  listActiveJobs() {
    const rows = db
      .prepare(
        "SELECT uuid, status, progress FROM jobs WHERE status IN ('processing','queued','webhook') " +
          "ORDER BY CASE status WHEN 'processing' THEN 0 WHEN 'queued' THEN 1 WHEN 'webhook' THEN 2 ELSE 3 END, rowid ASC"
      )
      .all();
    return rows.map((r) => ({ uuid: r.uuid, status: r.status, progress: Number(r.progress || 0) }));
  },

  // Public listing of last failed jobs (most recent first)
  // Returns minimal fields: uuid, error
  listLastFailedJobs(limit = 20) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = db
      .prepare(
        "SELECT uuid, error FROM jobs WHERE status = 'error' ORDER BY rowid DESC LIMIT ?"
      )
      .all(n);
    return rows.map((r) => ({ uuid: r.uuid, error: r.error || null }));
  },

  // ASSETS (models & loras)
  createAsset(asset) {
    const now = new Date().toISOString();
    const row = {
      kind: asset.kind,
      name: asset.name ?? null,
      source_url: asset.source_url,
      example_prompt: asset.example_prompt ?? null,
      min: asset.min == null ? 1 : Number(asset.min),
      max: asset.max == null ? 1 : Number(asset.max),
      local_path: asset.local_path ?? null,
      created_at: now,
      updated_at: now,
    };
    const info = db.prepare(`
      INSERT INTO assets (kind, name, source_url, example_prompt, min, max, local_path, created_at, updated_at)
      VALUES (@kind, @name, @source_url, @example_prompt, @min, @max, @local_path, @created_at, @updated_at)
    `).run(row);
    return info.lastInsertRowid;
  },

  getAsset(id) {
    const r = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!r) return null;
    const imagesRows = listAssetImagesStmt.all(id);
    const images = imagesRows.map((row) => ({
      url: row.url,
      is_nsfw: !!row.is_nsfw,
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
      meta: deserialize(row.meta, null),
    }));
    return {
      id: r.id,
      kind: r.kind,
      name: r.name ?? null,
      source_url: r.source_url,
      example_prompt: r.example_prompt ?? null,
      min: Number(r.min),
      max: Number(r.max),
      local_path: r.local_path ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      images,
    };
  },

  // List assets with optional kind filter ('model' | 'lora').
  // Returns an array of asset objects matching getAsset() shape, ordered by created_at DESC.
  listAssets(kind) {
    let rows;
    if (kind && (String(kind) === 'model' || String(kind) === 'lora')) {
      rows = db
        .prepare('SELECT * FROM assets WHERE kind = ? ORDER BY datetime(created_at) DESC, id DESC')
        .all(String(kind));
    } else {
      rows = db.prepare('SELECT * FROM assets ORDER BY datetime(created_at) DESC, id DESC').all();
    }
    return rows.map((r) => {
      const imagesRows = listAssetImagesStmt.all(r.id);
      const images = imagesRows.map((row) => ({
        url: row.url,
        is_nsfw: !!row.is_nsfw,
        width: row.width == null ? null : Number(row.width),
        height: row.height == null ? null : Number(row.height),
        meta: deserialize(row.meta, null),
      }));
      return {
        id: r.id,
        kind: r.kind,
        name: r.name ?? null,
        source_url: r.source_url,
        example_prompt: r.example_prompt ?? null,
        min: Number(r.min),
        max: Number(r.max),
        local_path: r.local_path ?? null,
        created_at: r.created_at,
        updated_at: r.updated_at,
        images,
      };
    });
  },

  // Insert a new image record for an asset
  addAssetImage(image) {
    if (image.asset_id == null) {
      throw new Error('addAssetImage: asset_id is required');
    }
    const row = {
      asset_id: image.asset_id,
      url: String(image.url),
      is_nsfw: image.is_nsfw ? 1 : 0,
      width: image.width == null ? null : Number(image.width),
      height: image.height == null ? null : Number(image.height),
      meta: image.meta == null ? null : serialize(image.meta),
      created_at: new Date().toISOString(),
    };
    insertAssetImageStmt.run(row);
    return true;
  },

  // List images for an asset id
  listAssetImages(asset_id) {
    const rows = listAssetImagesStmt.all(asset_id);
    return rows.map((row) => ({
      url: row.url,
      is_nsfw: !!row.is_nsfw,
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
      meta: deserialize(row.meta, null),
    }));
  },
};
