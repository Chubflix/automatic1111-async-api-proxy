const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {deserialize, serialize} = require("./json");

const DB_PATH = path.join(process.cwd(), process.env.DB_PATH || 'db.sqlite');

// Ensure directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  try {
    fs.mkdirSync(dir, {recursive: true});
  } catch (e) {
    console.warn('Could not create DB directory:', dir, e.message);
  }
}

let rawDb = null;
let dbApi = null;

function getDb() {
  if (!rawDb) {
    rawDb = new Database(DB_PATH);
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('synchronous = NORMAL');
  }
  return rawDb;
}

function initDb() {
  if (dbApi) return dbApi;

  const db = getDb();

  // Prepare all statements
  const statements = {
    insertJob: db.prepare(`
      INSERT INTO jobs (uuid, status, progress, request, result, error, webhookUrl, webhookKey, created_at, workflow, completed_at)
      VALUES (@uuid, @status, @progress, @request, @result, @error, @webhookUrl, @webhookKey, @created_at, @workflow, @completed_at)
    `),
    getJob: db.prepare(`SELECT uuid,
                               status,
                               progress,
                               request,
                               result,
                               error,
                               webhookUrl,
                               webhookKey,
                               created_at,
                               completed_at,
                               workflow,
                               retry_count,
                               last_retry,
                               ready,
                               ready_at
                        FROM jobs
                        WHERE uuid = ?`),
    updateStatus: db.prepare(`UPDATE jobs
                              SET status = ?,
                                  completed_at = CASE WHEN ? IN ('completed', 'canceled', 'error') THEN datetime('now') ELSE completed_at END
                                  progress = CASE WHEN ? IN ('progress', 'canceled', 'error') THEN 1 ELSE progress END
                              WHERE uuid = ?`),
    updateProgress: db.prepare(`UPDATE jobs
                                SET progress = ?
                                WHERE uuid = ?`),
    updateRetry: db.prepare(`UPDATE jobs
                             SET retry_count = retry_count + 1,
                                 last_retry  = ?
                             WHERE uuid = ?`),
    // Select next ready job, oldest first by created_at
    getNextReady: db.prepare(`
      SELECT uuid,
             status,
             progress,
             request,
             result,
             error,
             webhookUrl,
             webhookKey,
             created_at,
             completed_at,
             workflow,
             retry_count,
             last_retry,
             ready,
             ready_at
      FROM jobs
      WHERE (ready = 1)
        AND ready_at <= ?
      ORDER BY datetime(created_at)
      LIMIT 1
    `),
    getActive: db.prepare(`
      SELECT uuid,
             status,
             progress,
             request,
             workflow,
             retry_count,
             ready,
             ready_at,
             last_retry,
             created_at,
             completed_at
      FROM jobs
      WHERE (status NOT IN ('completed', 'error', 'canceled') AND (ready_at <= ? OR ready_at IS NULL))
         OR (status IN ('completed', 'canceled') AND completed_at IS NOT NULL AND datetime(completed_at, '+5 minutes') >= datetime(?))
      ORDER BY rowid DESC
    `),
    listAssetImagesStmt: db.prepare(`
      SELECT asset_id, url, is_nsfw, width, height, meta
      FROM assets_images
      WHERE asset_id = ?
      ORDER BY id
    `),
    insertAssetImageStmt: db.prepare(`
      INSERT INTO assets_images (asset_id, url, is_nsfw, width, height, meta, created_at)
      VALUES (@asset_id, @url, @is_nsfw, @width, @height, @meta, @created_at)
    `),
  };

  dbApi = {
    jobs: {
      // list() returns array
      // get(uuid) returns null if not found, not undefined
      create(job) {
        if (!job.workflow) throw new Error('Missing workflow');

        const row = {
          uuid: job.uuid,
          status: job.status || 'pending',
          workflow: job.workflow || null,
          progress: Number(job.progress || 0),
          request: serialize(job.request || {}),
          result: job.result == null ? null : serialize(job.result),
          error: job.error ?? null,
          webhookUrl: job.webhookUrl ?? null,
          webhookKey: job.webhookKey ?? null,
          created_at: job.created_at || new Date().toISOString(),
          completed_at: job.completed_at ?? null,
        };
        statements.insertJob.run(row);
        return job.uuid;
      },
      get(uuid) {
        const row = statements.getJob.get(uuid);
        if (!row) return null;
        return {
          ...row,
          request: deserialize(row.request),
          result: deserialize(row.result),
        };
      },
      update(uuid, data) {
        const allowed = ['status', 'progress', 'request', 'result', 'error', 'webhookUrl', 'webhookKey', 'workflow', 'retry_count', 'last_retry', 'completed_at'];
        const fields = Object.keys(data || {}).filter(k => allowed.includes(k));
        if (fields.length === 0) return 0;

        const payload = {...data};

        // If status is being updated to completed, canceled, or error, set completed_at to now
        if (payload.status && ['completed', 'canceled', 'error'].includes(payload.status)) {
          payload.completed_at = new Date().toISOString();
          // Add completed_at to fields if it's not already there
          if (!fields.includes('completed_at')) {
            fields.push('completed_at');
          }

          payload.progress = 1;
          if (!fields.includes('progress')) {
            fields.push('progress');
          }
        }

        if ('request' in payload) payload.request = serialize(payload.request);
        if ('result' in payload && payload.result != null) payload.result = serialize(payload.result);

        const sets = fields.map(k => `${k} = @${k}`);
        const stmt = db.prepare(`UPDATE jobs
                                 SET ${sets.join(', ')}
                                 WHERE uuid = @uuid`);
        return stmt.run({uuid, ...payload}).changes;
      },
      error(uuid, errorMessage) {
        return this.update(uuid, {
          status: 'error',
          error: errorMessage,
          progress: 1,
          completed_at: new Date().toISOString()
        });
      },
      updateStatus(uuid, status) {
        return statements.updateStatus.run(status, status, uuid).changes;
      },
      updateProgress(uuid, progress) {
        return statements.updateProgress.run(progress, uuid).changes;
      },
      cancel(uuid) {
        const job = db.prepare(`SELECT *
                                FROM jobs
                                WHERE uuid = ?
                                  AND status NOT IN ('completed', 'error')
                                LIMIT 1`).get(uuid);
        if (!job) return false;

        this.updateStatus(uuid, 'canceled');
        return true;
      },
      getNextReady() {
        const row = statements.getNextReady.get(new Date().toISOString());
        if (!row) throw new Error('No ready jobs');
        return {
          ...row,
          request: deserialize(row.request),
          result: deserialize(row.result),
        };
      },
      listActive() {
        const now = new Date().toISOString();
        const rows = statements.getActive.all(now, now);
        return rows.map(r => ({
          uuid: r.uuid,
          status: r.status,
          progress: Number(r.progress || 0),
          retry_count: r.retry_count,
          ready: r.ready,
          ready_at: r.ready_at,
          last_retry: r.last_retry,
          created_at: r.created_at,
          completed_at: r.completed_at,
        }));
      },
      recentErrors(limit = 20) {
        const n = Math.max(1, Math.min(100, Number(limit) || 20));
        const rows = db
          .prepare(
            "SELECT uuid, error FROM jobs WHERE status = 'error' ORDER BY rowid DESC LIMIT ?"
          )
          .all(n);
        return rows.map((r) => ({uuid: r.uuid, error: r.error || null}));
      },
      incrementFailureCounter(jobUuid) {
        const now = new Date().toISOString();
        statements.updateRetry.run(now, jobUuid);
      },

      // getNextReady() - the next jobs where ready = 1 ordered by created_at (oldest first)
    },
    assets: {
      list(kind) {
        let rows;
        if (kind && (String(kind) === 'model' || String(kind) === 'lora')) {
          rows = db
            .prepare('SELECT * FROM assets WHERE kind = ? ORDER BY datetime(created_at) DESC, id DESC')
            .all(String(kind));
        } else {
          rows = db.prepare('SELECT * FROM assets ORDER BY datetime(created_at) DESC, id DESC').all();
        }
        return rows.map((r) => {
          const imagesRows = statements.listAssetImagesStmt.all(r.id);
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
      get(id) {
        const r = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
        if (!r) return null;
        const imagesRows = statements.listAssetImagesStmt.all(id);
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
      create(asset) {
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
      addImage(assetId, image) {
        const row = {
          asset_id: assetId,
          url: String(image.url),
          is_nsfw: image.is_nsfw ? 1 : 0,
          width: image.width == null ? null : Number(image.width),
          height: image.height == null ? null : Number(image.height),
          meta: image.meta == null ? null : serialize(image.meta),
          created_at: new Date().toISOString(),
        };
        statements.insertAssetImageStmt.run(row);
        return true;
      }
      // update
      // addImage(uuid, image)
      // ...
    },
  };

  return dbApi;
}

function getDbApi() {
  if (!dbApi) {
    throw new Error('DB not initialized. Call initDb() first.');
  }
  return dbApi;
}

module.exports = {
  getDb,
  initDb,
  getDbApi,
};
