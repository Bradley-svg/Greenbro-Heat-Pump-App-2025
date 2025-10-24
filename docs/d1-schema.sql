-- Device catalog & topology
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  site_id TEXT,
  firmware TEXT,
  map_version TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  key_hash TEXT NOT NULL, -- SHA-256 hex of the device key
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sites (
  site_id TEXT PRIMARY KEY,
  name TEXT,
  region TEXT,
  lat REAL,
  lon REAL
);

CREATE TABLE site_clients (
  client_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  PRIMARY KEY (client_id, site_id)
);
CREATE INDEX idx_site_clients_client ON site_clients (client_id);
CREATE INDEX idx_site_clients_site ON site_clients (site_id);

CREATE TABLE clients (
  client_id TEXT PRIMARY KEY,
  name TEXT
);

-- Telemetry & state
CREATE TABLE latest_state (
  device_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  supplyC REAL,
  returnC REAL,
  tankC REAL,
  ambientC REAL,
  flowLps REAL,
  compCurrentA REAL,
  eevSteps INTEGER,
  powerKW REAL,
  deltaT REAL,
  thermalKW REAL,
  cop REAL,
  cop_quality TEXT,
  mode TEXT,
  defrost INTEGER,
  online INTEGER,
  faults_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

CREATE TABLE telemetry (
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  deltaT REAL,
  thermalKW REAL,
  cop REAL,
  cop_quality TEXT,
  status_json TEXT,
  faults_json TEXT,
  PRIMARY KEY (device_id, ts)
);
CREATE INDEX idx_telemetry_ts ON telemetry (ts);

CREATE TABLE heartbeat (
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  rssi REAL,
  PRIMARY KEY (device_id, ts)
);

-- Alerting & incident response
CREATE TABLE alerts (
  alert_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL, -- open|ack|closed
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  meta_json TEXT,
  ack_by TEXT,
  ack_at TEXT
);
CREATE INDEX idx_alerts_device_state ON alerts (device_id, state);
CREATE INDEX idx_alerts_state_time ON alerts (state, opened_at);

CREATE TABLE alert_state (
  device_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  last_trigger_ts TEXT,
  dwell_start_ts TEXT,
  cooldown_until_ts TEXT,
  suppress INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, rule)
);

CREATE TABLE alert_comments (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  author TEXT NOT NULL,
  ts TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE alert_snoozes (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT,
  until_ts TEXT NOT NULL,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_snooze_device_type ON alert_snoozes (device_id, type, kind, until_ts);

CREATE TABLE incidents (
  incident_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_alert_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_incidents_site_started ON incidents (site_id, started_at);

CREATE TABLE incident_alerts (
  incident_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  PRIMARY KEY (incident_id, alert_id)
);
CREATE INDEX idx_incident_alerts_alert ON incident_alerts (alert_id);

-- Baselines & saved context
CREATE TABLE baselines_hourly (
  device_id TEXT NOT NULL,
  how INTEGER NOT NULL,
  dt_mean REAL,
  dt_std REAL,
  dt_n INTEGER,
  cop_mean REAL,
  cop_std REAL,
  cop_n INTEGER,
  PRIMARY KEY (device_id, how)
);
CREATE INDEX idx_baselines_device ON baselines_hourly (device_id);

CREATE TABLE device_baselines (
  baseline_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sample_json TEXT NOT NULL,
  thresholds_json TEXT,
  source_session_id TEXT,
  step_id TEXT,
  label TEXT,
  is_golden INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT
);
CREATE INDEX idx_baseline_device_kind ON device_baselines (device_id, kind);
CREATE INDEX idx_baseline_golden ON device_baselines (device_id, kind, is_golden);

CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  route TEXT NOT NULL,
  params_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_saved_views_user ON saved_views (user_id);

-- Maintenance & operational metrics
CREATE TABLE maintenance_windows (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  device_id TEXT,
  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX idx_maintenance_device ON maintenance_windows (device_id, start_ts);
CREATE INDEX idx_maintenance_site ON maintenance_windows (site_id, start_ts);

CREATE TABLE ops_metrics (
  ts TEXT NOT NULL,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  device_id TEXT
);
CREATE INDEX idx_ops_metrics_route_ts ON ops_metrics (route, ts);

CREATE TABLE writes (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  clamped_json TEXT,
  result TEXT NOT NULL
);

CREATE TABLE client_slos (
  client_id TEXT PRIMARY KEY,
  uptime_target REAL,
  ingest_target REAL,
  cop_target REAL,
  report_recipients TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Settings, audit & configuration
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  subject TEXT,
  device_id TEXT,
  action TEXT,
  payload_json TEXT
);
CREATE INDEX idx_audit_device_ts ON audit_log (device_id, ts);

CREATE TABLE export_log (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  exported_at TEXT NOT NULL DEFAULT (datetime('now')),
  meta_json TEXT
);
CREATE INDEX idx_export_log_date ON export_log (exported_at);

-- Commissioning workflow
CREATE TABLE commissioning_sessions (
  session_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  site_id TEXT,
  operator_sub TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress|passed|failed|aborted
  notes TEXT,
  checklist_id TEXT
);
CREATE INDEX idx_comm_dev ON commissioning_sessions (device_id);
CREATE INDEX idx_comm_site ON commissioning_sessions (site_id);
CREATE INDEX idx_comm_status ON commissioning_sessions (status);

CREATE TABLE commissioning_checklists (
  checklist_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL, -- ordered array of steps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  required_steps_json TEXT
);
CREATE UNIQUE INDEX uniq_comm_checklist_name_ver ON commissioning_checklists (name, version);

CREATE TABLE commissioning_steps (
  session_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL, -- pending|pass|fail|skip
  readings_json TEXT,
  comment TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, step_id),
  FOREIGN KEY (session_id) REFERENCES commissioning_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE commissioning_artifacts (
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- pdf|zip|labels
  r2_key TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, kind),
  FOREIGN KEY (session_id) REFERENCES commissioning_sessions(session_id) ON DELETE CASCADE
);

-- Reporting & exports
CREATE TABLE report_deliveries (
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
CREATE INDEX idx_report_deliveries_type ON report_deliveries (type);
CREATE INDEX idx_report_deliveries_client ON report_deliveries (client_id);
CREATE INDEX idx_report_deliveries_created ON report_deliveries (created_at DESC);
