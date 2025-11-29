-- Add completed_at field to jobs table
ALTER TABLE jobs ADD COLUMN completed_at TEXT;

-- Set completed_at to current time for all completed jobs that don't have a completed_at value
UPDATE jobs SET completed_at = datetime('now') WHERE status = 'completed' AND completed_at IS NULL;

-- Create a partial index on completed_at for completed jobs
CREATE INDEX IF NOT EXISTS idx_jobs_completed_at ON jobs(completed_at)
WHERE status = 'completed';
