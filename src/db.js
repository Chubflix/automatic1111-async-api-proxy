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
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('model','lora')),
      name TEXT,
      source_url TEXT NOT NULL,
      image_url TEXT,
      example_prompt TEXT,
      min REAL NOT NULL DEFAULT 1,
      max REAL NOT NULL DEFAULT 1,
      local_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind);
    CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
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
    db.prepare("UPDATE jobs SET status='webhook', progress=1, result=?, error=NULL WHERE uuid=?")
      .run(serialize(resultObj || null), uuid);
  },

  failJob(uuid, message) {
    db.prepare("UPDATE jobs SET status='error', error=? WHERE uuid=?").run(message || 'Unknown error', uuid);
  },

  // ASSETS (models & loras)
  createAsset(asset) {
    const now = new Date().toISOString();
    const row = {
      id: asset.id,
      kind: asset.kind,
      name: asset.name ?? null,
      source_url: asset.source_url,
      image_url: asset.image_url ?? null,
      example_prompt: asset.example_prompt ?? null,
      min: asset.min == null ? 1 : Number(asset.min),
      max: asset.max == null ? 1 : Number(asset.max),
      local_path: asset.local_path ?? null,
      created_at: now,
      updated_at: now,
    };
    db.prepare(`
      INSERT INTO assets (id, kind, name, source_url, image_url, example_prompt, min, max, status, error, local_path, created_at, updated_at)
      VALUES (@id, @kind, @name, @source_url, @image_url, @example_prompt, @min, @max, @status, @error, @local_path, @created_at, @updated_at)
    `).run(row);
    return row.id;
  },

  getAsset(id) {
    const r = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!r) return null;
    return {
      id: r.id,
      kind: r.kind,
      name: r.name ?? null,
      source_url: r.source_url,
      image_url: r.image_url ?? null,
      example_prompt: r.example_prompt ?? null,
      min: Number(r.min),
      max: Number(r.max),
      local_path: r.local_path ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  },
};
