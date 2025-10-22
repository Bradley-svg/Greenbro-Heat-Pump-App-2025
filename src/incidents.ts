export type IncidentSweepResult = { created: number; assigned: number };

type AlertRow = {
  alert_id: string;
  device_id: string;
  site_id: string | null;
  opened_at: string;
  closed_at: string | null;
  state: string;
};

type SiteIncidentState = {
  incidentId: string;
  lastAlertTs: number;
};

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

async function selectExistingIncidents(DB: D1Database, windowHours: number): Promise<Map<string, SiteIncidentState>> {
  const map = new Map<string, SiteIncidentState>();
  const rows = await DB.prepare(
    `SELECT incident_id, site_id, last_alert_at
       FROM incidents
      WHERE last_alert_at >= datetime('now', ?)
      ORDER BY last_alert_at`
  )
    .bind(`-${windowHours} hours`)
    .all<{ incident_id: string; site_id: string; last_alert_at: string }>();

  for (const row of rows.results ?? []) {
    const ts = parseTimestamp(row.last_alert_at);
    if (!row.site_id || ts == null) continue;
    const existing = map.get(row.site_id);
    if (!existing || existing.lastAlertTs < ts) {
      map.set(row.site_id, { incidentId: row.incident_id, lastAlertTs: ts });
    }
  }
  return map;
}

export async function sweepIncidents(DB: D1Database, windowHours = 48): Promise<IncidentSweepResult> {
  const siteState = await selectExistingIncidents(DB, windowHours);
  const cutoff = `-${windowHours} hours`;

  const alerts = await DB.prepare(
    `SELECT a.alert_id, a.device_id, a.opened_at, a.closed_at, a.state, d.site_id
       FROM alerts a
       JOIN devices d ON d.device_id = a.device_id
      WHERE a.opened_at >= datetime('now', ?)
        AND d.site_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM incident_alerts ia WHERE ia.alert_id = a.alert_id)
      ORDER BY d.site_id, a.opened_at`
  )
    .bind(cutoff)
    .all<AlertRow>();

  let created = 0;
  let assigned = 0;

  for (const row of alerts.results ?? []) {
    const siteId = row.site_id;
    if (!siteId) continue;
    const openedTs = parseTimestamp(row.opened_at);
    if (openedTs == null) continue;

    let targetIncident = siteState.get(siteId);
    const withinGap = targetIncident && openedTs - targetIncident.lastAlertTs <= 10 * 60 * 1000;

    if (!withinGap) {
      const incidentId = crypto.randomUUID();
      await DB.prepare(
        `INSERT INTO incidents (incident_id, site_id, started_at, last_alert_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
        .bind(incidentId, siteId, row.opened_at, row.opened_at)
        .run();
      targetIncident = { incidentId, lastAlertTs: openedTs };
      siteState.set(siteId, targetIncident);
      created += 1;
    }

    await DB.prepare(
      `INSERT OR IGNORE INTO incident_alerts (incident_id, alert_id)
       VALUES (?, ?)`
    )
      .bind(targetIncident!.incidentId, row.alert_id)
      .run();

    if (openedTs > targetIncident!.lastAlertTs) {
      await DB.prepare(
        `UPDATE incidents SET last_alert_at=?, updated_at=datetime('now') WHERE incident_id=?`
      )
        .bind(row.opened_at, targetIncident!.incidentId)
        .run();
      targetIncident!.lastAlertTs = openedTs;
    }

    assigned += 1;
  }

  await DB.prepare(
    `UPDATE incidents
        SET resolved_at = (
              SELECT MAX(COALESCE(a.closed_at, incidents.last_alert_at))
                FROM incident_alerts ia2
                JOIN alerts a ON a.alert_id = ia2.alert_id
               WHERE ia2.incident_id = incidents.incident_id
            ),
            updated_at = datetime('now')
      WHERE resolved_at IS NULL
        AND started_at >= datetime('now', ?)
        AND NOT EXISTS (
              SELECT 1 FROM incident_alerts ia3
              JOIN alerts a2 ON a2.alert_id = ia3.alert_id
             WHERE ia3.incident_id = incidents.incident_id
               AND a2.state IN ('open','ack')
        )`
  )
    .bind(`-${windowHours} hours`)
    .run();

  return { created, assigned };
}
