INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES
  ('baseline_cov_warn','0.60',datetime('now')),
  ('baseline_cov_crit','0.40',datetime('now')),
  ('baseline_drift_warn','0.8',datetime('now')),
  ('baseline_drift_crit','1.5',datetime('now')),
  ('baseline_dwell_s','600',datetime('now'));
