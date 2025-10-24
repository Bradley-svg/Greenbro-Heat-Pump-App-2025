CREATE TABLE IF NOT EXISTS idem (
  k TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_idem_ts ON idem(ts);

CREATE TABLE IF NOT EXISTS short_cycle_buf (
  device_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
