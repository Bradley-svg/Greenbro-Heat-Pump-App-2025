import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/app';
import { pruneR2Prefix } from '../src/lib/prune';
import type { Env, ExecutionContext } from '../src/types/env';

type ChecklistRow = {
  checklist_id: string;
  name: string;
  version: number;
  steps_json: string;
  created_at: string;
  required_steps_json?: string | null;
};

type SessionRow = {
  session_id: string;
  device_id: string;
  site_id: string | null;
  operator_sub: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  notes: string | null;
  checklist_id: string | null;
};

type StepRow = {
  session_id: string;
  step_id: string;
  title: string;
  state: string;
  readings_json: string | null;
  comment: string | null;
  updated_at: string;
};

type ArtifactRow = {
  session_id: string;
  kind: string;
  r2_key: string;
  size_bytes: number;
  created_at: string;
};

class MockD1PreparedStatement {
  #sql: string;
  #db: MockD1Database;
  #args: unknown[] = [];

  constructor(sql: string, db: MockD1Database) {
    this.#sql = sql;
    this.#db = db;
  }

  bind(...args: unknown[]) {
    this.#args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.#db.execute<T>(this.#sql, this.#args, 'first');
  }

  async all<T>(): Promise<{ results: T[] }> {
    return this.#db.execute<T>(this.#sql, this.#args, 'all');
  }

  async run(): Promise<{ success: boolean }> {
    return this.#db.execute(this.#sql, this.#args, 'run');
  }
}

class MockD1Database {
  #settings = new Map<string, string>([['read_only', '0']]);
  #checklists = new Map<string, ChecklistRow>();
  #sessions = new Map<string, SessionRow>();
  #steps = new Map<string, StepRow>();
  #artifacts = new Map<string, ArtifactRow>();
  #latest = new Map<string, { ts: string; metrics_json: string | null; delta_t: number | null; cop: number | null }>();
  #telemetry = new Map<
    string,
    Array<{ ts: string; metrics_json: string | null; delta_t: number | null; cop: number | null }>
  >();

  prepare(sql: string) {
    return new MockD1PreparedStatement(sql, this);
  }

  seedChecklist(row: ChecklistRow) {
    this.#checklists.set(row.checklist_id, row);
  }

  setSetting(key: string, value: string) {
    this.#settings.set(key, value);
  }

  seedLatestState(
    deviceId: string,
    row: { ts: string; metrics_json?: string | null; delta_t?: number | null; cop?: number | null },
  ) {
    this.#latest.set(deviceId, {
      ts: row.ts,
      metrics_json: row.metrics_json ?? null,
      delta_t: row.delta_t ?? null,
      cop: row.cop ?? null,
    });
  }

  seedTelemetry(
    deviceId: string,
    row: { ts: string; metrics_json?: string | null; delta_t?: number | null; cop?: number | null },
  ) {
    const existing = this.#telemetry.get(deviceId) ?? [];
    existing.push({
      ts: row.ts,
      metrics_json: row.metrics_json ?? null,
      delta_t: row.delta_t ?? null,
      cop: row.cop ?? null,
    });
    this.#telemetry.set(deviceId, existing);
  }

  getStep(sessionId: string, stepId: string) {
    return this.#steps.get(`${sessionId}:${stepId}`);
  }

  getArtifact(sessionId: string, kind: string) {
    return this.#artifacts.get(`${sessionId}|${kind}`);
  }

  #lastUpdated(sessionId: string): string | null {
    let latest: string | null = null;
    for (const step of this.#steps.values()) {
      if (step.session_id !== sessionId) continue;
      if (!latest || step.updated_at.localeCompare(latest) > 0) {
        latest = step.updated_at;
      }
    }
    return latest;
  }

  async execute<T>(sql: string, args: unknown[], mode: 'first' | 'all' | 'run') {
    if (sql.includes('FROM commissioning_sessions cs') && sql.includes('last_update')) {
      const includeOperator = sql.includes('operator_sub');
      const rows = [...this.#sessions.values()]
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .map((row) => ({
          session_id: row.session_id,
          device_id: row.device_id,
          site_id: row.site_id,
          status: row.status,
          started_at: row.started_at,
          finished_at: row.finished_at,
          notes: row.notes,
          last_update: this.#lastUpdated(row.session_id),
          checklist_id: row.checklist_id,
          ...(includeOperator ? { operator_sub: row.operator_sub } : {}),
        }));
      return { results: rows as unknown as T[] };
    }

    if (sql.startsWith('SELECT session_id, kind, r2_key, size_bytes, created_at FROM commissioning_artifacts WHERE session_id IN')) {
      const sessionIds = args.map((value) => String(value));
      const results: Array<{
        session_id: string;
        kind: string;
        r2_key: string;
        size_bytes: number | null;
        created_at: string;
      }> = [];
      for (const [key, artifact] of this.#artifacts.entries()) {
        const [session_id, kind] = key.split('|');
        if (!sessionIds.includes(session_id)) continue;
        results.push({
          session_id,
          kind,
          r2_key: artifact.r2_key,
          size_bytes: artifact.size_bytes,
          created_at: artifact.created_at,
        });
      }
      return { results: results as unknown as T[] };
    }

    if (sql.startsWith('SELECT coalesce(required_steps_json, steps_json) AS steps FROM commissioning_checklists')) {
      const session_id = String(args[0] ?? '');
      const session = this.#sessions.get(session_id);
      const checklist = session?.checklist_id ? this.#checklists.get(session.checklist_id) : undefined;
      if (!checklist) {
        return mode === 'first' ? (null as T | null) : { results: [] };
      }
      const steps = checklist.required_steps_json ?? checklist.steps_json;
      const row = { steps } as unknown as T;
      return mode === 'first' ? (row as T) : { results: [row] as unknown as T[] };
    }

    switch (sql) {
      case 'SELECT value FROM settings WHERE key=?': {
        const key = String(args[0]);
        const value = this.#settings.get(key) ?? null;
        return mode === 'first' ? ({ value } as unknown as T) : { results: [{ value }] };
      }
      case 'SELECT checklist_id,name,version,steps_json,required_steps_json FROM commissioning_checklists ORDER BY created_at DESC': {
        const rows = [...this.#checklists.values()]
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map(({ checklist_id, name, version, steps_json, required_steps_json }) => ({
            checklist_id,
            name,
            version,
            steps_json,
            required_steps_json: required_steps_json ?? null,
          } as T));
        return { results: rows };
      }
      case 'SELECT checklist_id,name,version,steps_json,required_steps_json FROM commissioning_checklists WHERE checklist_id=?': {
        const id = String(args[0] ?? '');
        const row = this.#checklists.get(id) ?? null;
        if (!row) {
          return mode === 'first' ? (null as T | null) : { results: [] };
        }
        const value = { ...row, required_steps_json: row.required_steps_json ?? null } as unknown as T;
        return mode === 'first' ? (value as T) : { results: [value] as unknown as T[] };
      }
      case 'SELECT steps_json FROM commissioning_checklists WHERE checklist_id=?': {
        const id = String(args[0] ?? '');
        const row = this.#checklists.get(id) ?? null;
        return mode === 'first'
          ? ((row ? ({ steps_json: row.steps_json } as unknown as T) : null) as T | null)
          : { results: row ? ([{ steps_json: row.steps_json }] as unknown as T[]) : [] };
      }
      case 'SELECT coalesce(required_steps_json, steps_json) AS steps FROM commissioning_checklists\n       WHERE checklist_id = (SELECT checklist_id FROM commissioning_sessions WHERE session_id=?)': {
        const session_id = String(args[0] ?? '');
        const session = this.#sessions.get(session_id);
        const checklist = session?.checklist_id ? this.#checklists.get(session.checklist_id) : undefined;
        if (!checklist) {
          return mode === 'first' ? (null as T | null) : { results: [] };
        }
        const steps = checklist.required_steps_json ?? checklist.steps_json;
        const row = { steps } as unknown as T;
        return mode === 'first' ? (row as T) : { results: [row] as unknown as T[] };
      }
      case 'INSERT INTO commissioning_sessions(session_id,device_id,site_id,operator_sub,notes,checklist_id) VALUES (?,?,?,?,?,?)': {
        const [session_id, device_id, site_id, operator_sub, notes, checklist_id] = args as [
          string,
          string,
          string | null,
          string,
          string | null,
          string | null,
        ];
        const now = new Date().toISOString();
        this.#sessions.set(session_id, {
          session_id,
          device_id,
          site_id: site_id ?? null,
          operator_sub,
          started_at: now,
          finished_at: null,
          status: 'in_progress',
          notes: notes ?? null,
          checklist_id: checklist_id ?? null,
        });
        return { success: true };
      }
      case 'INSERT INTO commissioning_steps(session_id,step_id,title,state) VALUES (?,?,?,?)': {
        const [session_id, step_id, title, state] = args as [string, string, string, string];
        const now = new Date().toISOString();
        this.#steps.set(`${session_id}:${step_id}`, {
          session_id,
          step_id,
          title,
          state,
          readings_json: null,
          comment: null,
          updated_at: now,
        });
        return { success: true };
      }
      case "UPDATE commissioning_steps SET state=?, readings_json=?, comment=?, updated_at=datetime('now') WHERE session_id=? AND step_id=?": {
        const [state, readings_json, comment, session_id, step_id] = args as [
          string,
          string | null,
          string | null,
          string,
          string,
        ];
        const key = `${session_id}:${step_id}`;
        const existing = this.#steps.get(key);
        if (existing) {
          existing.state = state;
          existing.readings_json = readings_json;
          existing.comment = comment;
          existing.updated_at = new Date().toISOString();
          this.#steps.set(key, existing);
        }
        return { success: true };
      }
      case "UPDATE commissioning_steps SET state=?, readings_json=?, updated_at=datetime('now') WHERE session_id=? AND step_id=?": {
        const [state, readings_json, session_id, step_id] = args as [string, string | null, string, string];
        const key = `${session_id}:${step_id}`;
        const existing = this.#steps.get(key);
        if (existing) {
          existing.state = state;
          existing.readings_json = readings_json;
          existing.updated_at = new Date().toISOString();
          this.#steps.set(key, existing);
        }
        return { success: true };
      }
      case "UPDATE commissioning_sessions SET status=?, finished_at=datetime('now'), notes=COALESCE(?,notes) WHERE session_id=?": {
        const [status, notes, session_id] = args as [string, string | null, string];
        const existing = this.#sessions.get(session_id);
        if (existing) {
          existing.status = status;
          existing.finished_at = new Date().toISOString();
          if (notes !== null) {
            existing.notes = notes;
          }
          this.#sessions.set(session_id, existing);
        }
        return { success: true };
      }
      case 'SELECT device_id FROM commissioning_sessions WHERE session_id=?': {
        const id = String(args[0] ?? '');
        const row = this.#sessions.get(id) ?? null;
        return row ? ({ device_id: row.device_id } as unknown as T) : null;
      }
      case 'SELECT device_id, site_id FROM commissioning_sessions WHERE session_id=?': {
        const id = String(args[0] ?? '');
        const row = this.#sessions.get(id) ?? null;
        return row ? ({ device_id: row.device_id, site_id: row.site_id } as unknown as T) : null;
      }
      case "SELECT r2_key FROM commissioning_artifacts WHERE session_id=? AND kind='pdf'": {
        const id = String(args[0] ?? '');
        const artifact = this.#artifacts.get(`${id}|pdf`) ?? null;
        return artifact ? ({ r2_key: artifact.r2_key } as unknown as T) : null;
      }
      case "SELECT r2_key FROM commissioning_artifacts WHERE session_id=? AND kind='zip'": {
        const id = String(args[0] ?? '');
        const artifact = this.#artifacts.get(`${id}|zip`) ?? null;
        return artifact ? ({ r2_key: artifact.r2_key } as unknown as T) : null;
      }
      case 'INSERT OR REPLACE INTO commissioning_artifacts(session_id,kind,r2_key,size_bytes) VALUES (?,?,?,?)':
      case 'INSERT OR REPLACE INTO commissioning_artifacts (session_id, kind, r2_key, size_bytes) VALUES (?,?,?,?)': {
        const [session_id, kind, r2_key, size_bytes] = args as [string, string, string, number];
        const now = new Date().toISOString();
        this.#artifacts.set(`${session_id}|${kind}`, {
          session_id,
          kind,
          r2_key,
          size_bytes,
          created_at: now,
        });
        return { success: true };
      }
      case 'SELECT session_id, device_id, site_id, operator_sub, started_at, finished_at, status, notes, checklist_id FROM commissioning_sessions WHERE session_id=?': {
        const id = String(args[0] ?? '');
        const row = this.#sessions.get(id) ?? null;
        return row
          ? (({
              session_id: row.session_id,
              device_id: row.device_id,
              site_id: row.site_id,
              operator_sub: row.operator_sub,
              started_at: row.started_at,
              finished_at: row.finished_at,
              status: row.status,
              notes: row.notes,
              checklist_id: row.checklist_id,
            } as unknown as T) as T)
          : null;
      }
      case 'SELECT * FROM commissioning_sessions WHERE session_id=?': {
        const id = String(args[0] ?? '');
        const row = this.#sessions.get(id) ?? null;
        return mode === 'first'
          ? ((row ? ({ ...row } as unknown as T) : null) as T | null)
          : { results: row ? ([{ ...row }] as unknown as T[]) : [] };
      }
      case 'SELECT step_id,title,state,readings_json,updated_at FROM commissioning_steps WHERE session_id=? ORDER BY updated_at': {
        const id = String(args[0] ?? '');
        const rows = [...this.#steps.values()]
          .filter((row) => row.session_id === id)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
        return { results: rows as unknown as T[] };
      }
      case 'SELECT step_id, state FROM commissioning_steps WHERE session_id=?': {
        const id = String(args[0] ?? '');
        const rows = [...this.#steps.values()]
          .filter((row) => row.session_id === id)
          .map((row) => ({ step_id: row.step_id, state: row.state }));
        return { results: rows as unknown as T[] };
      }
      case 'SELECT kind,r2_key,size_bytes,created_at FROM commissioning_artifacts WHERE session_id=?': {
        const id = String(args[0] ?? '');
        const rows: ArtifactRow[] = [];
        for (const artifact of this.#artifacts.values()) {
          if (artifact.session_id === id) {
            rows.push({ ...artifact });
          }
        }
        return mode === 'first'
          ? ((rows[0] ? (rows[0] as unknown as T) : null) as T | null)
          : ({ results: rows as unknown as T[] });
      }
      case 'SELECT ts, metrics_json, delta_t, cop FROM latest_state WHERE device_id=?': {
        const id = String(args[0] ?? '');
        const row = this.#latest.get(id) ?? null;
        return row ? ({ ...row } as unknown as T) : null;
      }
      case 'SELECT ts, metrics_json, delta_t, cop FROM telemetry WHERE device_id=? ORDER BY ts DESC LIMIT 1': {
        const id = String(args[0] ?? '');
        const rows = this.#telemetry.get(id) ?? [];
        const row = rows.length > 0 ? rows[rows.length - 1] : null;
        return row ? ({ ...row } as unknown as T) : null;
      }
      case 'INSERT INTO ops_metrics (ts, route, status_code, duration_ms, device_id) VALUES (?, ?, ?, ?, ?)': {
        return { success: true };
      }
      default:
        throw new Error(`Unhandled SQL in mock: ${sql}`);
    }
  }
}

class MockR2Bucket {
  #objects = new Map<
    string,
    { body: Uint8Array; uploaded: Date; httpMetadata?: { contentType?: string } }
  >();

  async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    const body = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.#objects.set(key, { body, uploaded: new Date(), httpMetadata: options?.httpMetadata });
  }

  getObject(key: string) {
    return this.#objects.get(key) ?? null;
  }

  async list({ prefix = '', cursor, limit = 1000 }: { prefix?: string; cursor?: string; limit?: number }) {
    const keys = [...this.#objects.keys()].filter((key) => key.startsWith(prefix));
    let start = 0;
    if (cursor) {
      start = Number(cursor);
    }
    const slice = keys.slice(start, start + limit);
    const objects = slice.map((key) => ({ key, uploaded: this.#objects.get(key)!.uploaded }));
    const next = start + slice.length < keys.length ? String(start + slice.length) : undefined;
    return { objects, cursor: next, truncated: next !== undefined };
  }

  async delete(key: string) {
    this.#objects.delete(key);
  }

  setUploaded(key: string, date: Date) {
    const entry = this.#objects.get(key);
    if (entry) {
      entry.uploaded = date;
      this.#objects.set(key, entry);
    }
  }

  async createSignedUrl({ key }: { key: string; expiration: Date }) {
    return new URL(`https://example.com/${encodeURIComponent(key)}`);
  }
}

function createEnv(): Env & { REPORTS: MockR2Bucket; DB: MockD1Database } {
  const db = new MockD1Database();
  db.seedChecklist({
    checklist_id: 'greenbro-standard-v1',
    name: 'greenbro-standard',
    version: 1,
    steps_json: JSON.stringify([
      { id: 'sensors_sane', title: 'Sensors sane' },
      { id: 'deltaT_under_load', title: 'Delta T under load' },
      { id: 'flow_detected', title: 'Flow detected' },
      { id: 'heartbeat_seen', title: 'Heartbeat seen' },
      { id: 'alert_fires_and_clears', title: 'Alert fires and clears' },
      { id: 'labels_printed', title: 'Labels printed' },
      { id: 'handover_complete', title: 'Handover complete' },
    ]),
    created_at: new Date().toISOString(),
    required_steps_json: JSON.stringify([
      'sensors_sane',
      'deltaT_under_load',
      'flow_detected',
      'heartbeat_seen',
      'alert_fires_and_clears',
      'handover_complete',
    ]),
  });
  db.setSetting('commissioning_delta_t_min', '5');
  db.setSetting('commissioning_flow_min_lpm', '6');
  db.setSetting('commissioning_cop_min', '2.5');
  db.setSetting('commissioning_report_recipients', 'qa@greenbro.example,ops@greenbro.example');
  db.setSetting('ops_webhook_url', 'https://hooks.example/ops');
  const bucket = new MockR2Bucket();
  const doStub = {
    idFromName: () => 'stub',
    get: () => ({
      fetch: async () => new Response('Not implemented', { status: 501 }),
    }),
  } as unknown as Env['DeviceState'];

  const env = {
    DB: db as unknown as Env['DB'],
    CONFIG: {} as Env['CONFIG'],
    REPORTS: bucket as unknown as Env['REPORTS'],
    BRAND: bucket as unknown as Env['BRAND'],
    ARCHIVE: bucket as unknown as Env['ARCHIVE'],
    INGEST_Q: { send: async () => {} } as Env['INGEST_Q'],
    DeviceState: doStub,
    DEVICE_DO: doStub,
    ACCESS_AUD: 'test-aud',
    ACCESS_ISS: 'test-iss',
    ACCESS_JWKS: 'https://example.com/jwks',
    JWT_SECRET: 'secret',
    DEV_AUTH_BYPASS: '1',
  } satisfies Env;
  return Object.assign(env, { REPORTS: bucket, BRAND: bucket, ARCHIVE: bucket, DB: db }) as Env & {
    REPORTS: MockR2Bucket;
    BRAND: MockR2Bucket;
    ARCHIVE: MockR2Bucket;
    DB: MockD1Database;
  };
}

function createCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as ExecutionContext;
}

test('ingest schema rejects invalid payloads', async () => {
  const env = createEnv();
  const ctx = createCtx();
  const req = new Request('http://test/api/ingest/default', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, false);
});

test('heartbeat schema rejects invalid payloads', async () => {
  const env = createEnv();
  const ctx = createCtx();
  const req = new Request('http://test/api/heartbeat/default', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, false);
});

test('commissioning flow stores step updates and generates PDF artifact', async () => {
  const env = createEnv();
  const ctx = createCtx();

  const startRes = await worker.fetch(
    new Request('http://test/api/commissioning/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: 'device-1',
        site_id: 'site-1',
        checklist_id: 'greenbro-standard-v1',
        notes: 'Initial install',
      }),
    }),
    env,
    ctx,
  );
  assert.equal(startRes.status, 200);
  const startBody = (await startRes.json()) as { ok: boolean; session_id: string };
  assert.equal(startBody.ok, true);
  const sessionId = startBody.session_id;
  assert.ok(sessionId);

  const passRes = await worker.fetch(
    new Request('http://test/api/commissioning/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        step_id: 'sensors_sane',
        state: 'pass',
        readings: { outlet_temp_c: 45 },
      }),
    }),
    env,
    ctx,
  );
  assert.equal(passRes.status, 200);

  const failRes = await worker.fetch(
    new Request('http://test/api/commissioning/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        step_id: 'deltaT_under_load',
        state: 'fail',
        comment: 'ΔT below threshold',
      }),
    }),
    env,
    ctx,
  );
  assert.equal(failRes.status, 200);

  const finalRes = await worker.fetch(
    new Request('http://test/api/commissioning/finalise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, outcome: 'failed', notes: 'Needs revisit' }),
    }),
    env,
    ctx,
  );
  assert.equal(finalRes.status, 200);
  const finalBody = (await finalRes.json()) as { ok: boolean; r2_key: string };
  assert.equal(finalBody.ok, true);
  assert.ok(finalBody.r2_key);

  const stored = env.REPORTS.getObject(finalBody.r2_key);
  assert.ok(stored, 'expected PDF artifact to be written');
  assert.ok((stored?.body.length ?? 0) > 0, 'pdf bytes should be non-empty');
  assert.equal(stored?.httpMetadata?.contentType, 'application/pdf');
});

test('finalise enforces required steps before passing session', async () => {
  const env = createEnv();
  const ctx = createCtx();

  const startRes = await worker.fetch(
    new Request('http://test/api/commissioning/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'device-gate', checklist_id: 'greenbro-standard-v1' }),
    }),
    env,
    ctx,
  );
  const { session_id: sessionId } = (await startRes.json()) as { session_id: string };

  const passStep = async (step_id: string) => {
    await worker.fetch(
      new Request('http://test/api/commissioning/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, step_id, state: 'pass' }),
      }),
      env,
      ctx,
    );
  };

  await passStep('sensors_sane');
  await passStep('deltaT_under_load');
  await passStep('flow_detected');
  await passStep('heartbeat_seen');
  await passStep('alert_fires_and_clears');
  await worker.fetch(
    new Request('http://test/api/commissioning/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, step_id: 'labels_printed', state: 'skip' }),
    }),
    env,
    ctx,
  );

  const firstFinalise = await worker.fetch(
    new Request('http://test/api/commissioning/finalise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, outcome: 'passed' }),
    }),
    env,
    ctx,
  );
  assert.equal(firstFinalise.status, 409);
  const firstBody = (await firstFinalise.json()) as { error: string; missing: string[] };
  assert.equal(firstBody.error, 'required_steps_not_passed');
  assert.ok(firstBody.missing.includes('handover_complete'));

  await passStep('handover_complete');

  const secondFinalise = await worker.fetch(
    new Request('http://test/api/commissioning/finalise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, outcome: 'passed' }),
    }),
    env,
    ctx,
  );
  assert.equal(secondFinalise.status, 200);
  const secondBody = (await secondFinalise.json()) as { ok: boolean };
  assert.equal(secondBody.ok, true);
});

test('measure-now updates step with latest telemetry', async () => {
  const env = createEnv();
  const ctx = createCtx();

  const startRes = await worker.fetch(
    new Request('http://test/api/commissioning/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'device-2', checklist_id: 'greenbro-standard-v1' }),
    }),
    env,
    ctx,
  );
  const { session_id: sessionId } = (await startRes.json()) as { session_id: string };

  env.DB.seedLatestState('device-2', {
    ts: '2024-01-01T00:00:00.000Z',
    metrics_json: JSON.stringify({ outlet_temp_c: 47, return_temp_c: 40, flow_lpm: 6.2 }),
    delta_t: null,
    cop: 3.1,
  });

  const measureRes = await worker.fetch(
    new Request('http://test/api/commissioning/measure-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, step_id: 'deltaT_under_load' }),
    }),
    env,
    ctx,
  );
  assert.equal(measureRes.status, 200);
  const measureBody = (await measureRes.json()) as { ok: boolean; pass: boolean; delta_t: number };
  assert.equal(measureBody.ok, true);
  assert.equal(measureBody.pass, true);
  assert.ok(measureBody.delta_t >= 5);

  const step = env.DB.getStep(sessionId, 'deltaT_under_load');
  assert.ok(step);
  assert.equal(step?.state, 'pass');
  assert.ok(step?.readings_json);
  const readings = JSON.parse(step!.readings_json ?? '{}') as { delta_t: number; flow_lpm: number };
  assert.equal(readings.delta_t >= 5, true);
  assert.equal(readings.flow_lpm >= 6, true);
});

test('labels endpoint stores artifact in R2', async () => {
  const env = createEnv();
  const ctx = createCtx();

  const startRes = await worker.fetch(
    new Request('http://test/api/commissioning/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'device-3', site_id: 'site-9', checklist_id: 'greenbro-standard-v1' }),
    }),
    env,
    ctx,
  );
  const { session_id: sessionId } = (await startRes.json()) as { session_id: string };

  const labelsRes = await worker.fetch(
    new Request('http://test/api/commissioning/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    }),
    env,
    ctx,
  );
  assert.equal(labelsRes.status, 200);
  const body = (await labelsRes.json()) as { r2_key: string };
  assert.ok(body.r2_key);

  const stored = env.REPORTS.getObject(body.r2_key);
  assert.ok(stored, 'expected labels PDF to be persisted');
  assert.equal(stored?.httpMetadata?.contentType, 'application/pdf');

  const dbArtifact = env.DB.getArtifact(sessionId, 'labels');
  assert.ok(dbArtifact);
  assert.equal(dbArtifact?.r2_key, body.r2_key);
});

test('email-bundle posts to ops webhook with PDF and ZIP links', async () => {
  const env = createEnv();
  const ctx = createCtx();

  const startRes = await worker.fetch(
    new Request('http://test/api/commissioning/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'device-4', checklist_id: 'greenbro-standard-v1' }),
    }),
    env,
    ctx,
  );
  const { session_id: sessionId } = (await startRes.json()) as { session_id: string };

  await env.DB.prepare('INSERT OR REPLACE INTO commissioning_artifacts(session_id,kind,r2_key,size_bytes) VALUES (?,?,?,?)')
    .bind(sessionId, 'pdf', 'reports/session.pdf', 2048)
    .run();
  await env.DB.prepare('INSERT OR REPLACE INTO commissioning_artifacts(session_id,kind,r2_key,size_bytes) VALUES (?,?,?,?)')
    .bind(sessionId, 'zip', 'provisioning/session.zip', 1024)
    .run();
  await env.REPORTS.put('reports/session.pdf', new Uint8Array([1, 2, 3]), {
    httpMetadata: { contentType: 'application/pdf' },
  });
  await env.REPORTS.put('provisioning/session.zip', new Uint8Array([9, 9, 9]));

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init?.body ? String(init.body) : '';
    calls.push({ url, body });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const res = await worker.fetch(
      new Request('http://test/api/commissioning/email-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      }),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://hooks.example/ops');
    assert.ok(calls[0].body.includes(`Session ${sessionId}`));
    assert.ok(calls[0].body.includes('Report: https://example.com/'));
    assert.ok(calls[0].body.includes('Provisioning ZIP: https://example.com/'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pruneR2Prefix removes old provisioning zips', async () => {
  const env = createEnv();
  await env.REPORTS.put('provisioning/old.zip', new Uint8Array([1]));
  await env.REPORTS.put('provisioning/new.zip', new Uint8Array([2]));
  env.REPORTS.setUploaded('provisioning/old.zip', new Date(Date.now() - 200 * 86400_000));
  env.REPORTS.setUploaded('provisioning/new.zip', new Date());

  await pruneR2Prefix(env.REPORTS as any, 'provisioning/', 180);

  assert.equal(env.REPORTS.getObject('provisioning/old.zip'), null);
  assert.ok(env.REPORTS.getObject('provisioning/new.zip'));
});
