import type { Env } from '../types/env';

declare const BUILD_SHA: string;
declare const BUILD_DATE: string;
declare const BUILD_SOURCE: string;

const REQUIRED_TABLES = ['devices', 'alerts', 'telemetry', 'heartbeat'] as const;
const PLACEHOLDERS = {
  sha: '__BUILD_SHA__',
  date: '__BUILD_DATE__',
  source: '__BUILD_SOURCE__',
} as const;

function readDefined(value: string | undefined | null, placeholder: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === placeholder) {
    return undefined;
  }
  return trimmed;
}

function getCompileTimeMeta() {
  const sha = typeof BUILD_SHA !== 'undefined' ? BUILD_SHA : undefined;
  const date = typeof BUILD_DATE !== 'undefined' ? BUILD_DATE : undefined;
  const source = typeof BUILD_SOURCE !== 'undefined' ? BUILD_SOURCE : undefined;
  return { sha, date, source };
}

export async function getVersion(env: Env) {
  const schema = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('devices','alerts','telemetry','heartbeat')",
  ).all<{ name: string }>();
  const present = new Set((schema.results || []).map((row) => row.name));

  const compileTime = getCompileTimeMeta();
  const buildSha =
    readDefined(compileTime.sha, PLACEHOLDERS.sha) ??
    readDefined(env.BUILD_SHA, PLACEHOLDERS.sha) ??
    'dev';
  const buildDate = readDefined(compileTime.date, PLACEHOLDERS.date) ?? readDefined(env.BUILD_DATE, PLACEHOLDERS.date) ?? '';
  const buildSource =
    readDefined(compileTime.source, PLACEHOLDERS.source) ?? readDefined(env.BUILD_SOURCE, PLACEHOLDERS.source) ?? '';

  return {
    build_sha: buildSha,
    build_date: buildDate,
    build_source: buildSource,
    schema_ok: REQUIRED_TABLES.every((name) => present.has(name)),
    tables_present: Array.from(present).sort(),
  };
}
