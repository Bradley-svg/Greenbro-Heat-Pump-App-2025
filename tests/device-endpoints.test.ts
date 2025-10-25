import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import appModule from '../src/app';
import type { Env, ExecutionContext } from '../src/types/env';
import type { IngestMessage } from '../src/types';

type CommandStatus = 'pending' | 'applied' | 'failed' | 'expired';

class MockStatement {
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

  async run() {
    return this.#db._run(this.#sql, this.#args);
  }

  async first<T>() {
    return this.#db._first<T>(this.#sql, this.#args);
  }

  async all<T>() {
    return this.#db._all<T>(this.#sql, this.#args);
  }
}

type DeviceRow = {
  device_id: string;
  profile_id: string;
  key_hash: string;
};

type CommandRow = {
  command_id: string;
  device_id: string;
  profile_id: string | null;
  actor: string;
  body_json: string;
  created_at: string;
  expires_at: string;
  status: CommandStatus;
  ack_status?: CommandStatus | null;
  ack_detail?: string | null;
  ack_at?: string | null;
  attempts: number;
  delivered_at?: string | null;
  write_id?: string | null;
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

class MockD1Database {
  devices = new Map<string, DeviceRow>();
  deviceCommands = new Map<string, CommandRow>();
  writes = new Map<string, { result: string | null }>();
  idem = new Map<string, string>();
  opsMetrics: Array<{ route: string; status: number }> = [];

  prepare(sql: string) {
    return new MockStatement(sql, this);
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    for (const stmt of statements) {
      await stmt.run();
    }
  }

  async _run(sql: string, args: unknown[]) {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('INSERT INTO device_commands')) {
      const [commandId, deviceId, profileId, actor, bodyJson, createdAt, expiresAt, writeId] = args as [
        string,
        string,
        string | null,
        string,
        string,
        string,
        string,
        string | null,
      ];
      this.deviceCommands.set(commandId, {
        command_id: commandId,
        device_id: deviceId,
        profile_id: profileId ?? null,
        actor,
        body_json: bodyJson,
        created_at: createdAt,
        expires_at: expiresAt,
        status: 'pending',
        ack_status: null,
        ack_detail: null,
        ack_at: null,
        attempts: 0,
        delivered_at: null,
        write_id: writeId ?? null,
      });
      return { success: true };
    }
    if (normalized.startsWith('UPDATE device_commands SET attempts')) {
      const [commandId] = args as [string];
      const row = this.deviceCommands.get(commandId);
      if (row) {
        row.attempts += 1;
        row.delivered_at = row.delivered_at ?? new Date().toISOString();
      }
      return { success: true };
    }
    if (normalized.startsWith('UPDATE device_commands SET status=?, ack_status')) {
      const [status, ackStatus, detail, ackAt, commandId, deviceId] = args as [
        CommandStatus,
        CommandStatus,
        string | null,
        string,
        string,
        string,
      ];
      const row = this.deviceCommands.get(commandId);
      if (row && row.device_id === deviceId) {
        row.status = status;
        row.ack_status = ackStatus;
        row.ack_detail = detail ?? null;
        row.ack_at = ackAt;
      }
      return { success: true };
    }
    if (normalized.startsWith('INSERT INTO writes')) {
      const [id, , , , , , , result] = args as [string, unknown, unknown, unknown, unknown, unknown, unknown, string];
      this.writes.set(id, { result });
      return { success: true };
    }
    if (normalized.startsWith('UPDATE writes SET result=? WHERE id=?')) {
      const [result, id] = args as [string, string];
      const row = this.writes.get(id);
      if (row) {
        row.result = result;
      }
      return { success: true };
    }
    if (normalized.startsWith('INSERT OR IGNORE INTO idem')) {
      const [key] = args as [string];
      if (!this.idem.has(key)) {
        this.idem.set(key, new Date().toISOString());
      }
      return { success: true };
    }
    if (normalized.startsWith('DELETE FROM idem')) {
      this.idem.clear();
      return { success: true };
    }
    if (normalized.startsWith('INSERT INTO ops_metrics')) {
      const [, route, status] = args as [string, string, number];
      this.opsMetrics.push({ route, status });
      return { success: true };
    }
    return { success: true };
  }

  async _first<T>(sql: string, args: unknown[]): Promise<T | null> {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('SELECT key_hash FROM devices')) {
      const [id] = args as [string];
      const row = this.devices.get(id);
      return (row ? { key_hash: row.key_hash } : null) as T | null;
    }
    if (normalized.startsWith('SELECT profile_id FROM devices')) {
      const [id] = args as [string];
      const row = this.devices.get(id);
      return (row ? { profile_id: row.profile_id } : null) as T | null;
    }
    if (normalized.startsWith('SELECT k FROM idem')) {
      const [key] = args as [string];
      return (this.idem.has(key) ? { k: key } : null) as T | null;
    }
    if (normalized.startsWith('SELECT status, write_id FROM device_commands')) {
      const [commandId, deviceId] = args as [string, string];
      const row = this.deviceCommands.get(commandId);
      if (row && row.device_id === deviceId) {
        return { status: row.status, write_id: row.write_id ?? null } as T;
      }
      return null;
    }
    if (normalized.startsWith("SELECT name FROM sqlite_master WHERE type='table'")) {
      const nameFromArg =
        args.length > 0 && typeof args[0] === 'string' && args[0].length > 0 ? (args[0] as string) : null;
      const match = normalized.match(/name\s*=\s*'([^']+)'/);
      const target = nameFromArg ?? (match ? match[1] : null);
      if (!target) {
        return null;
      }
      return ({ name: target } as unknown) as T;
    }
    return null;
  }

  async _all<T>(sql: string, args: unknown[]): Promise<{ results: T[] }> {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('UPDATE device_commands') && normalized.includes("status='expired'")) {
      const rows: Array<{ command_id: string; write_id: string | null }> = [];
      const now = Date.now();
      for (const row of this.deviceCommands.values()) {
        if (
          row.status === 'pending' &&
          new Date(row.expires_at).getTime() < now &&
          (!args.length || row.device_id === args[0])
        ) {
          row.status = 'expired';
          row.ack_status = 'expired';
          row.ack_detail = 'Expired before device acknowledgement';
          row.ack_at = new Date().toISOString();
          rows.push({ command_id: row.command_id, write_id: row.write_id ?? null });
        }
      }
      return { results: rows as T[] };
    }
    if (normalized.startsWith('SELECT command_id, body_json, created_at, expires_at')) {
      const [deviceId, limit] = args as [string, number];
      const rows = Array.from(this.deviceCommands.values())
        .filter((row) => row.device_id === deviceId && row.status === 'pending')
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit)
        .map((row) => ({
          command_id: row.command_id,
          body_json: row.body_json,
          created_at: row.created_at,
          expires_at: row.expires_at,
        }));
      return { results: rows as T[] };
    }
    return { results: [] as T[] };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildEnv(db: MockD1Database, overrides: Partial<Env> = {}): Env {
  const operations: Array<IngestMessage> = [];
  const deviceStateFetches: Array<{ url: string; body: unknown }> = [];

  const env: Env = {
    DB: db as unknown as Env['DB'],
    CONFIG: {} as any,
    REPORTS: {} as any,
    BRAND: {} as any,
    ARCHIVE: {} as any,
    INGEST_Q: {
      async send(message: IngestMessage) {
        operations.push(message);
      },
    } as unknown as Env['INGEST_Q'],
    DeviceState: {
      idFromName: (name: string) => `state:${name}`,
      get: () => ({
        async fetch(url: string, init?: RequestInit) {
          const raw = init?.body ? JSON.parse(String(init.body)) : null;
          deviceStateFetches.push({ url, body: raw });
          return new Response(
            JSON.stringify({
              result: 'accepted',
              desired: raw?.command ?? {},
              clamped: {},
              issuedAt: new Date().toISOString(),
              writeId: raw?.commandId ?? 'cmd-test',
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      }),
    } as unknown as Env['DeviceState'],
    DEVICE_DO: {
      idFromName: (name: string) => `audit:${name}`,
      get: () => ({
        async fetch(_url: string, init?: RequestInit) {
          const raw = init?.body ? JSON.parse(String(init.body)) : null;
          if (raw?.commandId) {
            db.writes.set(raw.commandId, { result: 'pending' });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }),
    } as unknown as Env['DEVICE_DO'],
    ACCESS_AUD: 'aud',
    ACCESS_ISS: 'iss',
    ACCESS_JWKS: 'https://example/jwks.json',
    JWT_SECRET: 'secret',
    WRITE_MIN_C: '35',
    WRITE_MAX_C: '65',
    DEV_AUTH_BYPASS: '0',
    CORS_ALLOWED_ORIGINS: undefined,
    REPORTS_PUBLIC_BASE_URL: undefined,
    BUILD_SHA: 'test',
    BUILD_DATE: new Date().toISOString(),
    BUILD_SOURCE: 'test',
    ALLOW_AUTH_BYPASS: undefined,
  };

  return Object.assign(env, overrides, {
    // expose captured operations for assertions
    __operations: operations,
    __stateCalls: deviceStateFetches,
  });
}

const ctx: ExecutionContext = {
  waitUntil(promise: Promise<unknown>) {
    void promise;
  },
  passThroughOnException() {},
} as ExecutionContext;

test('ingest enqueues telemetry payload', async () => {
  const db = new MockD1Database();
  const deviceKey = 'test-key-123';
  db.devices.set('HP-100', {
    device_id: 'HP-100',
    profile_id: 'profile-1',
    key_hash: sha256(deviceKey),
  });
  const env = buildEnv(db);
  const request = new Request('https://worker/api/ingest/profile-1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GREENBRO-DEVICE-KEY': deviceKey },
    body: JSON.stringify({
      device_id: 'HP-100',
      ts: '2025-10-25T12:34:56Z',
      metrics: {
        supply_c: 48.2,
        return_c: 42.7,
        flow_lps: 0.25,
      },
      status: {
        mode: 'heating',
        defrost: false,
      },
    }),
  });
  const res = await appModule.fetch(request, env as unknown as Env, ctx);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.queued, true);
  const operations = (env as any).__operations as IngestMessage[];
  assert.equal(operations.length, 1);
  assert.equal(operations[0].type, 'telemetry');
  assert.equal(operations[0].body.metrics.supplyC, 48.2);
});

test('heartbeat enqueue', async () => {
  const db = new MockD1Database();
  const deviceKey = 'test-key-456';
  db.devices.set('HP-101', {
    device_id: 'HP-101',
    profile_id: 'profile-1',
    key_hash: sha256(deviceKey),
  });
  const env = buildEnv(db);
  const request = new Request('https://worker/api/heartbeat/profile-1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GREENBRO-DEVICE-KEY': deviceKey },
    body: JSON.stringify({
      device_id: 'HP-101',
      timestamp: '2025-10-25T12:35:00Z',
      rssi: -63,
    }),
  });
  const res = await appModule.fetch(request, env as unknown as Env, ctx);
  assert.equal(res.status, 202);
  const operations = (env as any).__operations as IngestMessage[];
  assert.equal(operations.length, 1);
  assert.equal(operations[0].type, 'heartbeat');
  assert.equal(operations[0].body.deviceId, 'HP-101');
});

test('command poll and acknowledgement lifecycle', async () => {
  const db = new MockD1Database();
  const deviceKey = 'test-key-789';
  const deviceId = 'HP-102';
  db.devices.set(deviceId, {
    device_id: deviceId,
    profile_id: 'profile-1',
    key_hash: sha256(deviceKey),
  });
  const commandId = 'cmd-demo';
  const created = new Date().toISOString();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.deviceCommands.set(commandId, {
    command_id: commandId,
    device_id: deviceId,
    profile_id: 'profile-1',
    actor: 'operator@example.com',
    body_json: JSON.stringify({ mode: 'heating' }),
    created_at: created,
    expires_at: expires,
    status: 'pending',
    ack_status: null,
    ack_detail: null,
    ack_at: null,
    attempts: 0,
    delivered_at: null,
    write_id: commandId,
  });
  db.writes.set(commandId, { result: 'pending' });

  const env = buildEnv(db);

  const pollReq = new Request(`https://worker/api/device/${deviceId}/commands/poll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GREENBRO-DEVICE-KEY': deviceKey,
    },
    body: JSON.stringify({ max: 1 }),
  });
  const pollRes = await appModule.fetch(pollReq, env as unknown as Env, ctx);
  assert.equal(pollRes.status, 200);
  const pollBody = await pollRes.json();
  assert.equal(Array.isArray(pollBody.commands), true);
  assert.equal(pollBody.commands[0].id, commandId);
  assert.equal(pollBody.commands[0].body.mode, 'heating');

  const ackReq = new Request(`https://worker/api/device/${deviceId}/commands/${commandId}/ack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GREENBRO-DEVICE-KEY': deviceKey,
    },
    body: JSON.stringify({ status: 'applied', details: 'ok' }),
  });
  const ackRes = await appModule.fetch(ackReq, env as unknown as Env, ctx);
  assert.equal(ackRes.status, 200);
  const commandRow = db.deviceCommands.get(commandId);
  assert.ok(commandRow);
  assert.equal(commandRow?.status, 'applied');
  assert.equal(commandRow?.ack_status, 'applied');
  assert.equal(commandRow?.ack_detail, 'ok');
  const writeRow = db.writes.get(commandId);
  assert.equal(writeRow?.result, 'applied');
  const stateCalls = (env as any).__stateCalls as Array<{ url: string; body: unknown }>;
  assert.equal(stateCalls.some((call) => call.url.endsWith('/command/ack')), true);
});
