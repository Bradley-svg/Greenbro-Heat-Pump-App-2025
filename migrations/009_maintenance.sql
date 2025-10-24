CREATE TABLE IF NOT EXISTS maintenance_windows (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  device_id TEXT,
  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_maintenance_device ON maintenance_windows(device_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_maintenance_site ON maintenance_windows(site_id, start_ts);

CREATE TABLE IF NOT EXISTS ops_metrics (
  ts TEXT NOT NULL,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  device_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_ops_metrics_route_ts ON ops_metrics(route, ts);
