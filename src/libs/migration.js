import path from "path";
import fs from "fs/promises";

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL,
    success INTEGER NOT NULL,
    error TEXT
  )
`;

async function runMigrations(db) {
    const migrationsDir = path.join(process.cwd(), 'migrations');

    console.log('🔄 Checking migrations directory:', migrationsDir);

    try {
        await fs.access(migrationsDir);
    } catch {
        console.log('📁 No migrations directory found, skipping');
        return;
    }

    console.log('📋 Ensuring migrations table exists...');
    await db.exec(MIGRATIONS_TABLE);

    const appliedMigrations = new Set(
        db.prepare('SELECT name FROM _migrations WHERE success = 1')
            .all()
            .map(row => row.name)
    );

    console.log(`✅ ${appliedMigrations.size} migrations already applied`);

    const migrationFiles = await fs.readdir(migrationsDir)
        .then(files => files
            .filter(file => file.endsWith('.sql'))
            .sort()
        );

    console.log(`📂 Found ${migrationFiles.length} migration files`);

    for (const filename of migrationFiles) {
        if (appliedMigrations.has(filename)) {
            console.log(`⏭️  Skipping already applied: ${filename}`);
            continue;
        }

        console.log(`🚀 Applying migration: ${filename}`);
        const filePath = path.join(migrationsDir, filename);
        const sql = await fs.readFile(filePath, 'utf8');

        await db.exec('BEGIN');

        try {
            await db.exec(sql);

            await db.prepare(
                'INSERT OR REPLACE INTO _migrations(name, applied_at, success, error) VALUES (?, ?, 1, NULL)'
            ).run(filename, new Date().toISOString());

            await db.exec('COMMIT');
            console.log(`✅ Successfully applied: ${filename}`);
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => {});

            await db.prepare(
                'INSERT OR REPLACE INTO _migrations(name, applied_at, success, error) VALUES (?, ?, 0, ?)'
            ).run(filename, new Date().toISOString(), error.message || String(error));

            console.error(`❌ Failed migration ${filename}:`, error.message);
        }
    }

    console.log('🎉 Migration run completed');
}

export { runMigrations };