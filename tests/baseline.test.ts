import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/app';
import type { Env, ExecutionContext } from '../src/types/env';
import { evaluateBaselineAlerts } from '../src/alerts';

type BaselineRow = {
  baseline_id: string;
  device_id: string;
  kind: string;
  created_at: string;
  sample_json: string;
  thresholds_json: string | null;
  source_session_id: string | null;
  step_id: string | null;
  label: string | null;
  is_golden: number;
  expires_at: string | null;
};

type TelemetryRow = {
  ts: number;
  delta_t: number | null;
  cop: number | null;
  compressor_current: number | null;
};

type AlertRow = {
  alert_id: string;
  device_id: string;
  type: string;
  severity: string;
  state: string;
  opened_at: string;
  closed_at: string | null;
  meta_json: string | null;
};

type SnoozeRow = {
  device_id: string;
  type: string;
  kind: string | null;
  until_ts: string;
};

class MockBaselineStatement {
  #sql: string;
  #db: MockBaselineDB;
  #args: unknown[] = [];

  constructor(sql: string, db: MockBaselineDB) {
    this.#sql = sql;
    this.#db = db;
  }

  bind(...args: unknown[]) {
    this.#args = args;
    return this;
  }

  async run() {
    return this.#db.execute(this.#sql, this.#args, 'run');
  }

  async all<T>() {
    return this.#db.execute<T>(this.#sql, this.#args, 'all');
  }

  async first<T>() {
    return this.#db.execute<T>(this.#sql, this.#args, 'first');
  }
}

class MockBaselineDB {
  #settings = new Map<string, string>();
  #baselines: BaselineRow[] = [];
  #telemetry = new Map<string, TelemetryRow[]>();
  #alerts: AlertRow[] = [];
  #alertState = new Map<string, { last_trigger_ts: string | null; dwell_start_ts: string | null; cooldown_until_ts: string | null; suppress: number }>();
  #snoozes: SnoozeRow[] = [];
  #clock = 0;

  constructor() {
    this.#settings.set('read_only', '0');
    this.#settings.set('baseline_cov_warn', '0.60');
    this.#settings.set('baseline_cov_crit', '0.40');
    this.#settings.set('baseline_drift_warn', '0.8');
    this.#settings.set('baseline_drift_crit', '1.5');
    this.#settings.set('baseline_dwell_s', '600');
    this.#settings.set('baseline_cov_warn_cop', '0.60');
    this.#settings.set('baseline_cov_crit_cop', '0.40');
    this.#settings.set('baseline_drift_warn_cop', '0.15');
    this.#settings.set('baseline_drift_crit_cop', '0.30');
    this.#settings.set('baseline_cov_warn_current', '0.60');
    this.#settings.set('baseline_cov_crit_current', '0.40');
    this.#settings.set('baseline_drift_warn_current', '1.0');
    this.#settings.set('baseline_drift_crit_current', '2.0');
  }

  prepare(sql: string) {
    return new MockBaselineStatement(sql, this);
  }

  seedTelemetry(
    deviceId: string,
    ts: number,
    values: { delta_t?: number | null; cop?: number | null; current?: number | null } = {},
  ) {
    const entry: TelemetryRow = {
      ts,
      delta_t: values.delta_t ?? null,
      cop: values.cop ?? null,
      compressor_current: values.current ?? null,
    };
    const existing = this.#telemetry.get(deviceId) ?? [];
    existing.push(entry);
    this.#telemetry.set(deviceId, existing);
  }

  addSnooze(deviceId: string, type: string, kind: string | null, until: string) {
    this.#snoozes.push({ device_id: deviceId, type, kind, until_ts: until });
  }

  async execute<T>(sql: string, args: unknown[], mode: 'run' | 'all' | 'first') {
    if (sql.startsWith('SELECT value FROM settings WHERE key=?')) {
      const key = String(args[0] ?? '');
      const value = this.#settings.get(key) ?? null;
      if (mode === 'first') {
        return (value == null ? null : { value }) as T | null;
      }
      return { results: value == null ? [] : [{ value }] } as unknown as T;
    }

    if (sql.startsWith('INSERT INTO alert_state')) {
      const [deviceId, rule, last, dwell, cooldown, suppress] = args as [string, string, string | null, string | null, string | null, number];
      this.#alertState.set(`${deviceId}:${rule}`, {
        last_trigger_ts: last ?? null,
        dwell_start_ts: dwell ?? null,
        cooldown_until_ts: cooldown ?? null,
        suppress: suppress ?? 0,
      });
      return { success: true };
    }

    if (sql.startsWith('INSERT INTO alert_snoozes')) {
      const [, deviceId, type, kind, until] = args as [string, string, string, string | null, string];
      this.addSnooze(deviceId, type, kind ?? null, until);
      return { success: true };
    }

    if (sql.startsWith('SELECT last_trigger_ts')) {
      const [deviceId, rule] = args as [string, string];
      const state = this.#alertState.get(`${deviceId}:${rule}`);
      if (mode === 'first') {
        return state ? (state as unknown as T) : null;
      }
      return { results: state ? ([state] as unknown as T[]) : [] };
    }

    if (sql.includes('FROM alert_snoozes')) {
      const [deviceId, type, kind] = args as [string, string, string | null];
      const now = new Date();
      const active = this.#snoozes.find(
        (entry) =>
          entry.device_id === deviceId &&
          entry.type === type &&
          (!entry.kind || entry.kind === kind) &&
          new Date(entry.until_ts).getTime() > now.getTime(),
      );
      if (mode === 'first') {
        return active ? ({ 1: 1 } as unknown as T) : null;
      }
      return { results: active ? ([{ 1: 1 }] as unknown as T[]) : [] };
    }

    if (sql.startsWith('UPDATE alerts SET severity=')) {
      const [severity, metaJson, alertId] = args as [string, string, string];
      const row = this.#alerts.find((entry) => entry.alert_id === alertId);
      if (row) {
        row.severity = severity;
        row.meta_json = metaJson;
      }
      return { success: true };
    }

    if (sql.startsWith("UPDATE alerts SET state='closed'")) {
      const [closedAt, metaJson, alertId] = args as [string, string, string];
      const row = this.#alerts.find((entry) => entry.alert_id === alertId);
      if (row) {
        row.state = 'closed';
        row.closed_at = closedAt;
        row.meta_json = metaJson;
      }
      return { success: true };
    }

    if (sql.startsWith('INSERT INTO alerts')) {
      const [alertId, deviceId, type, severity, openedAt, metaJson] = args as [string, string, string, string, string, string | null];
      const row: AlertRow = {
        alert_id: alertId,
        device_id: deviceId,
        type,
        severity,
        state: 'open',
        opened_at: openedAt,
        closed_at: null,
        meta_json: metaJson ?? null,
      };
      this.#alerts.push(row);
      return { success: true };
    }

    if (sql.startsWith('INSERT INTO device_baselines')) {
      const [baseline_id, device_id, kind, sample_json, thresholds_json, source_session_id, step_id, label, is_golden, expires_at] =
        args as [string, string, string, string, string | null, string | null, string | null, string | null, number | null, string | null];
      const row: BaselineRow = {
        baseline_id,
        device_id,
        kind,
        sample_json: String(sample_json),
        thresholds_json: thresholds_json ?? null,
        source_session_id: source_session_id ?? null,
        step_id: step_id ?? null,
        label: label ?? null,
        is_golden: is_golden ?? 0,
        expires_at: expires_at ?? null,
        created_at: new Date(Date.UTC(2024, 0, 1, 0, 0, this.#clock++)).toISOString(),
      };
      this.#baselines.push(row);
      return { success: true };
    }

    if (sql.startsWith('UPDATE device_baselines SET is_golden=0')) {
      const [deviceId, kind] = args as [string, string];
      for (const row of this.#baselines) {
        if (row.device_id === deviceId && row.kind === kind) {
          row.is_golden = 0;
        }
      }
      return { success: true };
    }

    if (sql.startsWith('SELECT sample_json FROM device_baselines')) {
      const [deviceId, kind] = args as [string, string];
      const row = [...this.#baselines]
        .filter((entry) => entry.device_id === deviceId && entry.kind === kind)
        .sort((a, b) => {
          if (b.is_golden !== a.is_golden) {
            return b.is_golden - a.is_golden;
          }
          return b.created_at.localeCompare(a.created_at);
        })[0];
      if (mode === 'first') {
        return row ? ({ sample_json: row.sample_json } as T) : null;
      }
      return { results: row ? ([{ sample_json: row.sample_json }] as T[]) : [] };
    }

    if (sql.startsWith('SELECT baseline_id, created_at')) {
      const [deviceId, kind] = args as [string, string];
      const rows = [...this.#baselines]
        .filter((entry) => entry.device_id === deviceId && entry.kind === kind)
        .sort((a, b) => {
          if (b.is_golden !== a.is_golden) {
            return b.is_golden - a.is_golden;
          }
          return b.created_at.localeCompare(a.created_at);
        })
        .slice(0, 20);
      return { results: rows as unknown as T[] };
    }

    if (sql.startsWith('SELECT kind FROM device_baselines WHERE baseline_id=?')) {
      const [baselineId, deviceId] = args as [string, string];
      const row = this.#baselines.find((entry) => entry.baseline_id === baselineId && entry.device_id === deviceId);
      if (mode === 'first') {
        return row ? ({ kind: row.kind } as T) : null;
      }
      return { results: row ? ([{ kind: row.kind }] as T[]) : [] };
    }

    if (sql.startsWith('SELECT alert_id') && sql.includes('FROM alerts')) {
      const [deviceId, type, maybeKind] = args as [string, string, string | undefined];
      const kind = maybeKind ?? 'delta_t';
      const rows = this.#alerts
        .filter((entry) => entry.device_id === deviceId && entry.type === type && (entry.state === 'open' || entry.state === 'ack'))
        .filter((entry) => {
          if (!sql.includes('json_extract')) {
            return true;
          }
          try {
            const meta = entry.meta_json ? JSON.parse(entry.meta_json) : null;
            const metaKind = typeof meta?.kind === 'string' ? meta.kind : 'delta_t';
            return metaKind === kind;
          } catch {
            return kind === 'delta_t';
          }
        })
        .sort((a, b) => b.opened_at.localeCompare(a.opened_at));
      const result = rows[0];
      if (mode === 'first') {
        if (!result) return null;
        if (sql.includes('severity')) {
          return ({ alert_id: result.alert_id, severity: result.severity } as unknown as T) ?? null;
        }
        return ({ alert_id: result.alert_id } as unknown as T) ?? null;
      }
      return { results: result ? ([result] as unknown as T[]) : [] };
    }

    if (sql.startsWith('SELECT')) {
      if (sql.includes('SUM(CASE WHEN severity')) {
        const warning = this.#alerts.filter(
          (entry) =>
            entry.type === 'baseline_deviation' &&
            (entry.state === 'open' || entry.state === 'ack') &&
            (entry.severity === 'major' || entry.severity === 'warning'),
        ).length;
        const critical = this.#alerts.filter(
          (entry) => entry.type === 'baseline_deviation' && (entry.state === 'open' || entry.state === 'ack') && entry.severity === 'critical',
        ).length;
        if (mode === 'first') {
          return { warning, critical } as unknown as T;
        }
        return { results: [{ warning, critical }] as unknown as T[] };
      }
    }

    if (sql.startsWith('UPDATE device_baselines SET')) {
      const [labelArg, goldenArg, expiresArg, baselineId, deviceId] = args as [string | null, number | null, string | null, string, string];
      const row = this.#baselines.find((entry) => entry.baseline_id === baselineId && entry.device_id === deviceId);
      if (row) {
        if (labelArg !== null && labelArg !== undefined) {
          row.label = labelArg;
        }
        if (goldenArg !== null && goldenArg !== undefined) {
          row.is_golden = goldenArg;
        }
        if (expiresArg !== null && expiresArg !== undefined) {
          row.expires_at = expiresArg;
        }
      }
      return { success: true };
    }

    if (sql.startsWith('DELETE FROM device_baselines WHERE baseline_id=?')) {
      const [baselineId, deviceId] = args as [string, string];
      this.#baselines = this.#baselines.filter(
        (entry) => !(entry.baseline_id === baselineId && entry.device_id === deviceId),
      );
      return { success: true };
    }

    if (sql.startsWith('SELECT ts,')) {
      const match = /SELECT ts,\s*([a-zA-Z_]+) AS v/.exec(sql);
      const column = match?.[1] ?? 'delta_t';
      const [deviceId, fromSeconds, toSeconds] = args as [string, number, number];
      const fromMs = Number(fromSeconds) * 1000;
      const toMs = Number(toSeconds) * 1000;
      const rows = (this.#telemetry.get(deviceId) ?? [])
        .filter((entry) => entry.ts >= fromMs && entry.ts <= toMs)
        .sort((a, b) => a.ts - b.ts)
        .map((entry) => ({
          ts: new Date(entry.ts).toISOString(),
          v: (entry as Record<string, number | null>)[column] ?? null,
        }));
      return { results: rows as unknown as T[] };
    }

    throw new Error(`Unsupported SQL: ${sql}`);
  }

  listAlerts() {
    return this.#alerts.map((entry) => ({ ...entry }));
  }

  setSetting(key: string, value: string) {
    this.#settings.set(key, value);
  }
}

function createCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as ExecutionContext;
}

function createEnv(
  db: MockBaselineDB,
  windowData: Record<string, Array<{ t: number; v: number | null }>> = {},
): Env {
  const bucket = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ objects: [] }),
  } as unknown as Env['REPORTS'];
  const doStub = {
    idFromName: () => ({ toString: () => 'stub' }),
    get: () => ({
      fetch: async (url: string) => {
        const target = new URL(url);
        if (target.pathname === '/window') {
          const kind = target.searchParams.get('kind') ?? 'delta_t';
          return new Response(JSON.stringify(windowData[kind] ?? []), { status: 200 });
        }
        return new Response(null, { status: 501 });
      },
    }),
  } as unknown as Env['DeviceState'];
  const config = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as Env['CONFIG'];
  return {
    DB: db as unknown as Env['DB'],
    CONFIG: config,
    REPORTS: bucket,
    BRAND: bucket,
    ARCHIVE: bucket,
    INGEST_Q: { send: async () => {} } as Env['INGEST_Q'],
    DeviceState: doStub,
    DEVICE_DO: doStub,
    ACCESS_AUD: 'test-aud',
    ACCESS_ISS: 'test-iss',
    ACCESS_JWKS: 'https://example.com/jwks.json',
    JWT_SECRET: 'secret',
    DEV_AUTH_BYPASS: '1',
  } satisfies Env;
}

test('baseline compare returns coverage and drift', async () => {
  const db = new MockBaselineDB();
  const env = createEnv(db);
  const ctx = createCtx();

  const createBaselineReq = new Request('http://test/api/devices/dev-1/baselines', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'delta_t',
      sample: { median: 5, p25: 4, p75: 6 },
      thresholds: null,
      label: 'Initial',
      is_golden: true,
    }),
  });
  const createRes = await worker.fetch(createBaselineReq, env, ctx);
  assert.equal(createRes?.status, 200);
  const { baseline_id } = (await createRes?.json()) as { baseline_id: string };
  assert.ok(baseline_id);

  const baseTs = Date.UTC(2024, 0, 1, 0, 0, 0);
  db.seedTelemetry('dev-1', baseTs + 1_000, { delta_t: 4 });
  db.seedTelemetry('dev-1', baseTs + 2_000, { delta_t: 6 });
  db.seedTelemetry('dev-1', baseTs + 3_000, { delta_t: 8 });

  const compareReq = new Request(
    `http://test/api/devices/dev-1/baseline-compare?kind=delta_t&from=${baseTs}&to=${baseTs + 4_000}`,
  );
  const compareRes = await worker.fetch(compareReq, env, ctx);
  assert.equal(compareRes?.status, 200);
  const body = (await compareRes?.json()) as {
    hasBaseline: boolean;
    coverage: number;
    drift: number;
    n: number;
  };
  assert.equal(body.hasBaseline, true);
  assert.equal(body.n, 3);
  assert.ok(Math.abs(body.coverage - 2 / 3) < 0.0001);
  assert.ok(Math.abs(body.drift - 1) < 0.0001);
});

test('baseline metadata updates enforce a single golden baseline', async () => {
  const db = new MockBaselineDB();
  const env = createEnv(db);
  const ctx = createCtx();

  async function createBaseline(label: string, isGolden = false) {
    const req = new Request('http://test/api/devices/dev-1/baselines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'delta_t',
        sample: { median: 5, p25: 4, p75: 6 },
        label,
        is_golden: isGolden,
      }),
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res?.status, 200);
    return (await res?.json()) as { baseline_id: string };
  }

  const first = await createBaseline('Primary', true);
  const second = await createBaseline('Secondary', false);

  const setGoldenReq = new Request(`http://test/api/devices/dev-1/baselines/${second.baseline_id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ is_golden: true }),
  });
  const setGoldenRes = await worker.fetch(setGoldenReq, env, ctx);
  assert.equal(setGoldenRes?.status, 200);

  const labelUpdateReq = new Request(`http://test/api/devices/dev-1/baselines/${second.baseline_id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Updated', expires_at: '2024-02-01T00:00:00.000Z' }),
  });
  const labelUpdateRes = await worker.fetch(labelUpdateReq, env, ctx);
  assert.equal(labelUpdateRes?.status, 200);

  const listRes = await worker.fetch(
    new Request('http://test/api/devices/dev-1/baselines?kind=delta_t'),
    env,
    ctx,
  );
  assert.equal(listRes?.status, 200);
  const list = (await listRes?.json()) as Array<{
    baseline_id: string;
    is_golden: boolean;
    label: string | null;
    expires_at: string | null;
  }>;
  assert.equal(list.length, 2);
  assert.equal(list[0]?.baseline_id, second.baseline_id);
  assert.equal(list[0]?.is_golden, true);
  assert.equal(list[0]?.label, 'Updated');
  assert.equal(list[0]?.expires_at, '2024-02-01T00:00:00.000Z');
  const formerGolden = list.find((entry) => entry.baseline_id === first.baseline_id);
  assert.ok(formerGolden);
  assert.equal(formerGolden?.is_golden, false);
});

test('baseline alerts evaluate per kind with independent dwell and severity', async () => {
  const db = new MockBaselineDB();
  db.setSetting('baseline_dwell_s', '0');
  db.setSetting('baseline_cov_warn_cop', '0.75');
  const baseTs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const windowData: Record<string, Array<{ t: number; v: number | null }>> = {
    cop: Array.from({ length: 10 }, (_, index) => ({
      t: baseTs + index * 1000,
      v: [2.6, 2.7, 2.9, 3.1, 3.0, 3.3, 3.2, 1.5, 3.8, 4.2][index] ?? 3,
    })),
    current: Array.from({ length: 10 }, (_, index) => ({
      t: baseTs + index * 1000,
      v: [12, 11, 9, 14, 5, 4, 15, 8, 13, 16][index] ?? 10,
    })),
  };
  const env = createEnv(db, windowData);
  const ctx = createCtx();

  async function createBaseline(kind: 'cop' | 'current', sample: { median: number; p25: number; p75: number }) {
    const req = new Request('http://test/api/devices/dev-1/baselines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, sample, thresholds: null, label: `${kind} baseline`, is_golden: true }),
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res?.status, 200);
  }

  await createBaseline('cop', { median: 3, p25: 2.5, p75: 3.5 });
  await createBaseline('current', { median: 8, p25: 6, p75: 10 });

  const now = Date.UTC(2024, 0, 1, 0, 10, 0);
  await evaluateBaselineAlerts(env as Env, 'dev-1', now);

  const alerts = db.listAlerts();
  assert.equal(alerts.length, 2);
  const copAlert = alerts.find((entry) => {
    try {
      const meta = entry.meta_json ? JSON.parse(entry.meta_json) : null;
      return meta?.kind === 'cop';
    } catch {
      return false;
    }
  });
  assert.ok(copAlert, 'expected COP alert');
  assert.equal(copAlert?.severity, 'major');
  const copMeta = copAlert?.meta_json ? JSON.parse(copAlert.meta_json) : {};
  assert.equal(copMeta.units, '');

  const currentAlert = alerts.find((entry) => {
    try {
      const meta = entry.meta_json ? JSON.parse(entry.meta_json) : null;
      return meta?.kind === 'current';
    } catch {
      return false;
    }
  });
  assert.ok(currentAlert, 'expected current alert');
  assert.equal(currentAlert?.severity, 'critical');
  const currentMeta = currentAlert?.meta_json ? JSON.parse(currentAlert.meta_json) : {};
  assert.equal(currentMeta.units, 'A');

  windowData.cop = Array.from({ length: 6 }, (_, index) => ({ t: baseTs + 20_000 + index * 1000, v: 3 }));
  await evaluateBaselineAlerts(env as Env, 'dev-1', now + 60_000);

  const after = db.listAlerts();
  const copAfter = after.find((entry) => {
    try {
      const meta = entry.meta_json ? JSON.parse(entry.meta_json) : null;
      return meta?.kind === 'cop';
    } catch {
      return false;
    }
  });
  const currentAfter = after.find((entry) => {
    try {
      const meta = entry.meta_json ? JSON.parse(entry.meta_json) : null;
      return meta?.kind === 'current';
    } catch {
      return false;
    }
  });

  assert.equal(copAfter?.state, 'closed');
  assert.equal(currentAfter?.state, 'open');
});

test('baseline alerts respect active snoozes', async () => {
  const db = new MockBaselineDB();
  db.setSetting('baseline_dwell_s', '0');
  db.setSetting('baseline_cov_warn_cop', '0.75');
  db.setSetting('baseline_cov_warn_current', '0.75');
  const baseTs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const windowData: Record<string, Array<{ t: number; v: number | null }>> = {
    cop: Array.from({ length: 6 }, (_, index) => ({ t: baseTs + index * 1000, v: 1.2 })),
    current: Array.from({ length: 6 }, (_, index) => ({ t: baseTs + index * 1000, v: 14 })),
  };
  const env = createEnv(db, windowData);
  const ctx = createCtx();

  async function createBaseline(kind: 'cop' | 'current', sample: { median: number; p25: number; p75: number }) {
    const req = new Request('http://test/api/devices/dev-1/baselines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, sample, thresholds: null, label: `${kind} baseline`, is_golden: true }),
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res?.status, 200);
  }

  await createBaseline('cop', { median: 3, p25: 2.5, p75: 3.5 });
  await createBaseline('current', { median: 8, p25: 6, p75: 10 });

  const now = Date.UTC(2024, 0, 1, 0, 10, 0);
  const future = new Date(Date.now() + 30_000).toISOString();
  db.addSnooze('dev-1', 'baseline_deviation', 'cop', future);

  await evaluateBaselineAlerts(env as Env, 'dev-1', now);

  const alerts = db.listAlerts();
  assert.equal(alerts.length, 1);
  const currentAlert = alerts[0];
  assert.equal(currentAlert?.type, 'baseline_deviation');
  const meta = currentAlert?.meta_json ? JSON.parse(currentAlert.meta_json) : {};
  assert.equal(meta.kind, 'current');
});
