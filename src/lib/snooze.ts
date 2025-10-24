export async function isSnoozed(DB: D1Database, deviceId: string, type: string, kind?: string | null) {
  const row = await DB.prepare(
    `SELECT 1 FROM alert_snoozes
       WHERE device_id=? AND type=? AND (kind IS NULL OR kind=?)
         AND until_ts > datetime('now')
       LIMIT 1`,
  )
    .bind(deviceId, type, kind ?? null)
    .first();
  return Boolean(row);
}
