import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/app';
import type { Env, ExecutionContext } from '../src/types/env';

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
  #clock = 0;

  constructor() {
    this.#settings.set('read_only', '0');
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

  async execute<T>(sql: string, args: unknown[], mode: 'run' | 'all' | 'first') {
    if (sql.startsWith('SELECT value FROM settings WHERE key=?')) {
      const key = String(args[0] ?? '');
      const value = this.#settings.get(key) ?? null;
      if (mode === 'first') {
        return (value == null ? null : { value }) as T | null;
      }
      return { results: value == null ? [] : [{ value }] } as unknown as T;
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
}

function createCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as ExecutionContext;
}

function createEnv(db: MockBaselineDB): Env {
  const bucket = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ objects: [] }),
  } as unknown as Env['REPORTS'];
  const doStub = {
    idFromName: () => ({ toString: () => 'stub' }),
    get: () => ({ fetch: async () => new Response(null, { status: 501 }) }),
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
