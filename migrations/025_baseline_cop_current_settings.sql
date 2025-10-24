INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES
  ('baseline_cov_warn_cop','0.60',datetime('now')),
  ('baseline_cov_crit_cop','0.40',datetime('now')),
  ('baseline_drift_warn_cop','0.15',datetime('now')),
  ('baseline_drift_crit_cop','0.30',datetime('now')),
  ('baseline_cov_warn_current','0.60',datetime('now')),
  ('baseline_cov_crit_current','0.40',datetime('now')),
  ('baseline_drift_warn_current','1.0',datetime('now')),
  ('baseline_drift_crit_current','2.0',datetime('now'));
