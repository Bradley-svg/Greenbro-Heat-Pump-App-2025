CREATE TABLE IF NOT EXISTS alert_snoozes (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT,
  until_ts TEXT NOT NULL,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snooze_device_type ON alert_snoozes(device_id, type, kind, until_ts);
