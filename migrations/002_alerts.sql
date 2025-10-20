-- Tracks rule state per device to implement dwell/cooldown/suppressors
CREATE TABLE IF NOT EXISTS alert_state (
  device_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  last_trigger_ts TEXT,
  dwell_start_ts TEXT,
  cooldown_until_ts TEXT,
  suppress INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, rule)
);

-- Who acknowledged
ALTER TABLE alerts ADD COLUMN ack_by TEXT;
ALTER TABLE alerts ADD COLUMN ack_at TEXT;

-- Optional comment thread for alerts
CREATE TABLE IF NOT EXISTS alert_comments (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  author TEXT NOT NULL,
  ts TEXT NOT NULL,
  body TEXT NOT NULL
);

-- Helpful index for listing
CREATE INDEX IF NOT EXISTS idx_alerts_state_time ON alerts (state, opened_at);
