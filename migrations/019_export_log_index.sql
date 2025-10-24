CREATE TABLE IF NOT EXISTS export_log (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  exported_at TEXT NOT NULL DEFAULT (datetime('now')),
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_export_log_date ON export_log (exported_at);
