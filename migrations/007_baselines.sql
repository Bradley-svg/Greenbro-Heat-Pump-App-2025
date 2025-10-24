CREATE TABLE IF NOT EXISTS baselines_hourly (
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

CREATE INDEX IF NOT EXISTS idx_baselines_device ON baselines_hourly(device_id);
