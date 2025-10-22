CREATE TABLE IF NOT EXISTS client_slos (
  client_id TEXT PRIMARY KEY,
  uptime_target REAL,
  ingest_target REAL,
  cop_target REAL,
  report_recipients TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
