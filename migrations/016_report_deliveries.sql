CREATE TABLE IF NOT EXISTS report_deliveries (
  delivery_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  client_id TEXT,
  site_id TEXT,
  path TEXT,
  recipients TEXT,
  subject TEXT,
  status TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_report_deliveries_type ON report_deliveries(type);
CREATE INDEX IF NOT EXISTS idx_report_deliveries_client ON report_deliveries(client_id);
CREATE INDEX IF NOT EXISTS idx_report_deliveries_created ON report_deliveries(created_at DESC);
