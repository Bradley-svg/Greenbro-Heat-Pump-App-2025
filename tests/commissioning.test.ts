import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/app';
import type { Env, ExecutionContext } from '../src/types/env';

type ChecklistRow = {
  checklist_id: string;
  name: string;
  version: number;
  steps_json: string;
  created_at: string;
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

  prepare(sql: string) {
    return new MockD1PreparedStatement(sql, this);
  }

  seedChecklist(row: ChecklistRow) {
    this.#checklists.set(row.checklist_id, row);
  }

  getArtifact(key: string) {
    return this.#artifacts.get(`${key}|pdf`);
  }

  async execute<T>(sql: string, args: unknown[], mode: 'first' | 'all' | 'run') {
    switch (sql) {
      case 'SELECT value FROM settings WHERE key=?': {
        const key = String(args[0]);
        const value = this.#settings.get(key) ?? null;
        return mode === 'first' ? ({ value } as unknown as T) : { results: [{ value }] };
      }
      case 'SELECT checklist_id,name,version FROM commissioning_checklists ORDER BY created_at DESC': {
        const rows = [...this.#checklists.values()]
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map(({ checklist_id, name, version }) => ({ checklist_id, name, version } as T));
        return { results: rows };
      }
      case 'SELECT checklist_id,name,version,steps_json FROM commissioning_checklists WHERE checklist_id=?': {
        const id = String(args[0] ?? '');
        const row = this.#checklists.get(id) ?? null;
        return mode === 'first'
          ? ((row ? ({ ...row } as unknown as T) : null) as T | null)
          : { results: row ? ([{ ...row }] as unknown as T[]) : [] };
      }
      case 'SELECT steps_json FROM commissioning_checklists WHERE checklist_id=?': {
        const id = String(args[0] ?? '');
        const row = this.#checklists.get(id) ?? null;
        return mode === 'first'
          ? ((row ? ({ steps_json: row.steps_json } as unknown as T) : null) as T | null)
          : { results: row ? ([{ steps_json: row.steps_json }] as unknown as T[]) : [] };
      }
      case 'INSERT INTO commissioning_sessions(session_id,device_id,site_id,operator_sub,notes) VALUES (?,?,?,?,?)': {
        const [session_id, device_id, site_id, operator_sub, notes] = args as [
          string,
          string,
          string | null,
          string,
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
      case 'INSERT OR REPLACE INTO commissioning_artifacts(session_id,kind,r2_key,size_bytes) VALUES (?,?,?,?)': {
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
      case 'INSERT INTO ops_metrics (ts, route, status_code, duration_ms, device_id) VALUES (?, ?, ?, ?, ?)': {
        return { success: true };
      }
      default:
        throw new Error(`Unhandled SQL in mock: ${sql}`);
    }
  }
}

class MockR2Bucket {
  #objects = new Map<string, { body: Uint8Array; httpMetadata?: { contentType?: string } }>();

  async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    const body = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.#objects.set(key, { body, httpMetadata: options?.httpMetadata });
  }

  getObject(key: string) {
    return this.#objects.get(key) ?? null;
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
  });
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
