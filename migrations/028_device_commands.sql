CREATE TABLE IF NOT EXISTS device_commands (
  command_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  profile_id TEXT,
  actor TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|applied|failed|expired
  ack_at TEXT,
  ack_status TEXT,
  ack_detail TEXT,
  write_id TEXT,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_commands_device_status
  ON device_commands(device_id, status, expires_at);

