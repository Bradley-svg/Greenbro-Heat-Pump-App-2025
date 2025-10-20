-- Sites catalogue (devices.site_id already exists). Keep minimal attributes for now.
CREATE TABLE IF NOT EXISTS sites (
  site_id TEXT PRIMARY KEY,
  name TEXT,
  region TEXT
);

-- Many-to-many mapping of clients to sites they may access.
CREATE TABLE IF NOT EXISTS site_clients (
  client_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  PRIMARY KEY (client_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_site_clients_client ON site_clients (client_id);
CREATE INDEX IF NOT EXISTS idx_site_clients_site ON site_clients (site_id);
