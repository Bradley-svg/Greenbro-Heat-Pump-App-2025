CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  route TEXT NOT NULL,
  params_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_saved_views_user ON saved_views(user_id);
