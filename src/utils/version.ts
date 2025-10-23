import type { Env } from '../types/env';

const REQUIRED_TABLES = ['devices', 'alerts', 'telemetry', 'heartbeat'] as const;

export async function getVersion(env: Env) {
  const schema = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('devices','alerts','telemetry','heartbeat')",
  ).all<{ name: string }>();
  const present = new Set((schema.results || []).map((row) => row.name));

  return {
    build_sha: env.BUILD_SHA || 'dev',
    build_date: env.BUILD_DATE || '',
    build_source: env.BUILD_SOURCE || '',
    schema_ok: REQUIRED_TABLES.every((name) => present.has(name)),
    tables_present: Array.from(present).sort(),
  };
}
