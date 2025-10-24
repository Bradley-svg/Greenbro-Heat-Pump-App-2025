-- Optional: mark steps as required in the catalogue (default true)
ALTER TABLE commissioning_checklists ADD COLUMN required_steps_json TEXT;
-- If the column exists already in your seed, skip this migration.

-- Backfill seed (example)
UPDATE commissioning_checklists
SET required_steps_json = json('["sensors_sane","deltaT_under_load","flow_detected","heartbeat_seen","alert_fires_and_clears","handover_complete"]')
WHERE name='greenbro-standard' AND version=1;
