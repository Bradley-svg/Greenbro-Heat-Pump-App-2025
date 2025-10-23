import type { D1Database } from '../types/env';

export async function getSetting(DB: D1Database, key: string): Promise<string | null> {
  const row = await DB.prepare('SELECT value FROM settings WHERE key=?')
    .bind(key)
    .first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function setSetting(DB: D1Database, key: string, value: string): Promise<void> {
  await DB.prepare(
    "INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  )
    .bind(key, value)
    .run();
}
