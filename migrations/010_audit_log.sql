CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  subject TEXT,
  device_id TEXT,
  action TEXT,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_device_ts ON audit_log(device_id, ts);
