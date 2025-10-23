CREATE TABLE IF NOT EXISTS device_baselines (
  baseline_id TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sample_json TEXT NOT NULL,
  thresholds_json TEXT,
  source_session_id TEXT,
  step_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_baseline_device_kind ON device_baselines(device_id, kind);
