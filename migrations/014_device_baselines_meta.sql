ALTER TABLE device_baselines ADD COLUMN label TEXT;
ALTER TABLE device_baselines ADD COLUMN is_golden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_baselines ADD COLUMN expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_baseline_golden ON device_baselines(device_id, kind, is_golden);
