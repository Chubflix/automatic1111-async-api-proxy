const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(process.cwd(), process.env.DB_PATH || 'db.sqlite');

// Ensure directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
    try {
        fs.mkdirSync(dir, { recursive: true });
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
        insertAssetImage: db.prepare(``),
    };

    dbApi = {
        jobs: {
            // list() returns array
            // get(uuid) returns null if not found, not undefined
            create(job) {
                const row = {
                    uuid: job.uuid,
                    status: job.status || 'pending',
                    progress: Number(job.progress || 0),
                    request: serialize(job.request || {}),
                    result: job.result == null ? null : serialize(job.result),
                    error: job.error ?? null,
                    webhookUrl: job.webhookUrl ?? null,
                    webhookKey: job.webhookKey ?? null,
                    created_at: job.created_at || new Date().toISOString(),
                    workflow: job.workflow || null,
                };
                statements.insertJob.run(row);
                return job.uuid;
            },
            // update
            // updateProgress
            // ...

            // getNextReady() - the next jobs where ready = 1 ordered by created_at (oldest first)
        },
        assets: {
            // list
            // create
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
