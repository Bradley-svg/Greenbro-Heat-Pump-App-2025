CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_alert_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incident_alerts (
  incident_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  PRIMARY KEY (incident_id, alert_id)
);

CREATE INDEX IF NOT EXISTS idx_incidents_site_started ON incidents (site_id, started_at);
CREATE INDEX IF NOT EXISTS idx_incident_alerts_alert ON incident_alerts (alert_id);
