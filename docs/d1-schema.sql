-- Devices and sites (minimal; extend with org/branch/site hierarchy as needed)
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  site_id TEXT,
  firmware TEXT,
  map_version TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  device_key_hash TEXT NOT NULL, -- SHA-256 hex of the device key
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Latest state (fast reads for dashboards)
CREATE TABLE IF NOT EXISTS latest_state (
  device_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  supplyC REAL, returnC REAL, tankC REAL, ambientC REAL,
  flowLps REAL, compCurrentA REAL, eevSteps INTEGER, powerKW REAL,
  deltaT REAL, thermalKW REAL, cop REAL, cop_quality TEXT,
  mode TEXT, defrost INTEGER, online INTEGER,
  faults_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

-- Telemetry (hot history; clustered by device & time)
CREATE TABLE IF NOT EXISTS telemetry (
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  deltaT REAL, thermalKW REAL, cop REAL, cop_quality TEXT,
  status_json TEXT, faults_json TEXT,
  PRIMARY KEY (device_id, ts)
);

CREATE TABLE IF NOT EXISTS heartbeat (
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  rssi REAL,
  PRIMARY KEY (device_id, ts)
);

-- Alerts
CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL, -- open|ack|closed
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  meta_json TEXT
);

-- Ops metrics (for /ops SLOs)
CREATE TABLE IF NOT EXISTS ops_metrics (
  ts TEXT NOT NULL,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  device_id TEXT
);

-- Writes audit
CREATE TABLE IF NOT EXISTS writes (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  clamped_json TEXT,
  result TEXT NOT NULL
);

-- Helpful indices
CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry (ts);
CREATE INDEX IF NOT EXISTS idx_alerts_device_state ON alerts (device_id, state);
