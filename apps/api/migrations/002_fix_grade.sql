ALTER TABLE incidents ADD COLUMN IF NOT EXISTS grade jsonb;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS run_id text;
CREATE INDEX IF NOT EXISTS incidents_run_id_idx ON incidents(run_id);
