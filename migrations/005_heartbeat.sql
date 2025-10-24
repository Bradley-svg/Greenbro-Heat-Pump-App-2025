CREATE TABLE IF NOT EXISTS heartbeat (
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  rssi REAL,
  PRIMARY KEY (device_id, ts)
);
