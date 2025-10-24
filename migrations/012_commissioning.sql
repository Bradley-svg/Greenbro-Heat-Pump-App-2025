-- Commissioning sessions (factory or field)
CREATE TABLE IF NOT EXISTS commissioning_sessions (
  session_id     TEXT PRIMARY KEY,
  device_id      TEXT NOT NULL,
  site_id        TEXT,
  operator_sub   TEXT NOT NULL,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT,
  status         TEXT NOT NULL DEFAULT 'in_progress', -- in_progress|passed|failed|aborted
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS idx_comm_dev ON commissioning_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_comm_site ON commissioning_sessions(site_id);
CREATE INDEX IF NOT EXISTS idx_comm_status ON commissioning_sessions(status);

-- Checklist catalogue (versioned)
CREATE TABLE IF NOT EXISTS commissioning_checklists (
  checklist_id   TEXT PRIMARY KEY,
  version        INTEGER NOT NULL,
  name           TEXT NOT NULL,
  steps_json     TEXT NOT NULL,        -- ordered array of steps with titles, ids, hints
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_comm_checklist_name_ver ON commissioning_checklists(name,version);

-- Session step results
CREATE TABLE IF NOT EXISTS commissioning_steps (
  session_id      TEXT NOT NULL,
  step_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  state           TEXT NOT NULL,       -- pending|pass|fail|skip
  readings_json   TEXT,                -- captured metrics (temps, flow, COP, etc.)
  comment         TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, step_id),
  FOREIGN KEY (session_id) REFERENCES commissioning_sessions(session_id) ON DELETE CASCADE
);

-- Artefacts (PDFs, labels, zipped provisioning)
CREATE TABLE IF NOT EXISTS commissioning_artifacts (
  session_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,       -- pdf|zip|labels
  r2_key          TEXT NOT NULL,
  size_bytes      INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, kind),
  FOREIGN KEY (session_id) REFERENCES commissioning_sessions(session_id) ON DELETE CASCADE
);

INSERT INTO commissioning_checklists(checklist_id, version, name, steps_json)
SELECT 'greenbro-standard-v1', 1, 'greenbro-standard', json('[
  {"id":"sensors_sane","title":"Sensors sane"},
  {"id":"deltaT_under_load","title":"Delta T under load"},
  {"id":"flow_detected","title":"Flow detected"},
  {"id":"heartbeat_seen","title":"Heartbeat seen"},
  {"id":"alert_fires_and_clears","title":"Alert fires and clears"},
  {"id":"labels_printed","title":"Labels printed"},
  {"id":"handover_complete","title":"Handover complete"}
]')
WHERE NOT EXISTS (
  SELECT 1 FROM commissioning_checklists WHERE name='greenbro-standard' AND version=1
);
