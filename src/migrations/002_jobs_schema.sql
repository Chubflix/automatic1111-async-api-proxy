-- Add/alter jobs table for retry/backoff and workflow fields
PRAGMA foreign_keys=ON;

-- Base new columns
ALTER TABLE jobs ADD COLUMN workflow TEXT;
ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN last_retry TEXT;

-- Computed columns
ALTER TABLE jobs ADD COLUMN ready_at TEXT GENERATED ALWAYS AS (
  CASE 
    WHEN retry_count = 0 THEN created_at
    ELSE datetime(last_retry, '+' || ((1 << retry_count) || ' minutes'))
  END
) VIRTUAL;

ALTER TABLE jobs ADD COLUMN ready INTEGER GENERATED ALWAYS AS (
  CASE 
    WHEN status = 'pending' OR status LIKE 'ready-for-%' THEN 1
    ELSE 0
  END
) VIRTUAL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_ready_created ON jobs(ready, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_readyat_status_created ON jobs(ready_at, status, created_at)
WHERE status = 'pending' OR status LIKE 'ready-for-%';
CREATE INDEX IF NOT EXISTS idx_jobs_status_created_updated ON jobs(status, created_at, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_retry_status_lastretry ON jobs(retry_count, last_retry, status)
WHERE retry_count > 0 AND (status = 'pending' OR status LIKE 'ready-for-%');
