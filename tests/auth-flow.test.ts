import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeJwt } from 'jose';

import worker from '../src/app';
import type { Env, ExecutionContext } from '../src/types/env';

type AuthUserRowData = {
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  password_salt: string | null;
  roles: string;
  client_ids: string | null;
};

class MockStatement {
  #sql: string;
  #db: MockAuthDB;
  #args: unknown[] = [];

  constructor(sql: string, db: MockAuthDB) {
    this.#sql = sql;
    this.#db = db;
  }

  bind(...args: unknown[]) {
    this.#args = args;
    return this;
  }

  async first<T>() {
    return this.#db.handleFirst<T>(this.#sql, this.#args);
  }

  async run() {
    this.#db.recordRun(this.#sql, this.#args);
    return { success: true };
  }

  async all<T>() {
    this.#db.recordRun(this.#sql, this.#args);
    return { results: [] } as unknown as T;
  }
}

class MockAuthDB {
  settings = new Map<string, string>();
  tables = new Set<string>(['auth_users']);
  authUsersById = new Map<string, AuthUserRowData>();
  authUsersByEmail = new Map<string, AuthUserRowData>();
  runs: Array<{ sql: string; args: unknown[] }> = [];

  setSetting(key: string, value: string) {
    this.settings.set(key, value);
  }

  prepare(sql: string) {
    return new MockStatement(sql, this);
  }

  recordRun(sql: string, args: unknown[]) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('INSERT INTO auth_users')) {
      const [id, email, passwordHash, passwordSalt, name, roles, clientIds] = args as [
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
      ];
      this.setAuthUser({
        id,
        email: email.toLowerCase(),
        name: name ?? null,
        password_hash: passwordHash,
        password_salt: passwordSalt ?? null,
        roles,
        client_ids: clientIds ?? null,
      });
    } else if (normalized.startsWith('UPDATE auth_users SET password_hash=?, password_salt=? WHERE id=?')) {
      const [passwordHash, passwordSalt, id] = args as [string, string | null, string];
      const existing = this.authUsersById.get(id);
      if (existing) {
        this.setAuthUser({
          ...existing,
          password_hash: passwordHash,
          password_salt: passwordSalt ?? null,
        });
      }
    } else if (normalized.startsWith('DELETE FROM settings WHERE key=?')) {
      const [key] = args as [string];
      this.settings.delete(key);
    }
    this.runs.push({ sql, args });
  }

  private setAuthUser(row: AuthUserRowData) {
    this.authUsersById.set(row.id, row);
    this.authUsersByEmail.set(row.email, row);
  }

  async handleFirst<T>(sql: string, args: unknown[]): Promise<T | null> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT value FROM settings WHERE key=?')) {
      const key = String(args[0] ?? '');
      const value = this.settings.has(key) ? this.settings.get(key)! : null;
      return (value == null ? null : ({ value } as T));
    }
    if (normalized.startsWith("SELECT name FROM sqlite_master WHERE type='table'")) {
      let target: string | null = null;
      if (args.length > 0 && typeof args[0] === 'string') {
        target = args[0] as string;
      }
      if (!target) {
        const literal = normalized.match(/name\s*=\s*'([^']+)'/);
        target = literal ? literal[1] : null;
      }
      if (target) {
        return (this.tables.has(target) ? ({ name: target } as T) : null);
      }
      const first = this.tables.values().next();
      return first.done ? null : (({ name: first.value } as unknown) as T);
    }
    if (
      normalized.startsWith(
        'SELECT id, email, name, password_hash, password_salt, roles, client_ids FROM auth_users WHERE email=?',
      )
    ) {
      const lookup = String(args[0] ?? '').toLowerCase();
      const row = this.authUsersByEmail.get(lookup);
      return (row ? ({ ...row } as unknown) : null) as T | null;
    }
    if (normalized === 'SELECT 1') {
      return ({ 1: 1 } as unknown) as T;
    }
    throw new Error(`Unexpected first() query: ${sql}`);
  }
}

class MockConfig {
  store = new Map<string, string>();
  puts: Array<{ key: string; value: string }> = [];
  deletes: string[] = [];

  async put(key: string, value: string) {
    this.store.set(key, value);
    this.puts.push({ key, value });
  }

  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  async delete(key: string) {
    this.deletes.push(key);
    this.store.delete(key);
  }
}

function createCtx() {
  const waits: Promise<unknown>[] = [];
  const ctx: ExecutionContext = {
    waitUntil(promise: Promise<unknown>) {
      waits.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;
  return { ctx, waits };
}

function createEnv(overrides: Partial<Env> = {}): { env: Env; db: MockAuthDB; config: MockConfig } {
  const db = new MockAuthDB();
  const config = new MockConfig();
  const base: Env = {
    DB: db as unknown as Env['DB'],
    CONFIG: config as unknown as Env['CONFIG'],
    REPORTS: {} as unknown as Env['REPORTS'],
    BRAND: {} as unknown as Env['BRAND'],
    ARCHIVE: {} as unknown as Env['ARCHIVE'],
    INGEST_Q: { sendBatch: async () => {} } as unknown as Env['INGEST_Q'],
    DeviceState: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
    } as unknown as Env['DeviceState'],
    DEVICE_DO: {} as unknown as Env['DEVICE_DO'],
    ACCESS_AUD: 'greenbro-app',
    ACCESS_ISS: 'greenbro-app',
    ACCESS_JWKS: 'https://example.test/jwks.json',
    ACCESS_JWKS_URL: 'https://example.test/jwks.json',
    JWT_SECRET: 'test-secret',
    WRITE_MIN_C: undefined,
    WRITE_MAX_C: undefined,
    DEV_AUTH_BYPASS: '0',
    CORS_ALLOWED_ORIGINS: undefined,
    REPORTS_PUBLIC_BASE_URL: undefined,
    BUILD_SHA: undefined,
    BUILD_DATE: undefined,
    BUILD_SOURCE: undefined,
  };
  const env = { ...base, ...overrides } satisfies Env;
  return { env, db, config };
}

test('POST /api/auth/login issues session tokens and stores refresh record', async () => {
  const { env, db, config } = createEnv();
  db.setSetting(
    'auth_users',
    JSON.stringify([
      {
        id: 'ops-1',
        email: 'ops@example.test',
        password: 'super-secret',
        roles: ['admin'],
        clientIds: ['client-123'],
      },
    ]),
  );

  const request = new Request('https://worker.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ops@example.test', password: 'super-secret' }),
  });

  const { ctx } = createCtx();
  const response = await worker.fetch(request, env, ctx);

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    user: { id: string; email: string; roles: string[]; clientIds: string[] };
    accessToken: string;
    refreshToken: string;
  };

  assert.deepEqual(body.user, {
    id: 'ops-1',
    email: 'ops@example.test',
    roles: ['admin'],
    clientIds: ['client-123'],
  });
  assert.equal(body.refreshToken.length, 64);

  const payload = decodeJwt(body.accessToken);
  assert.equal(payload.sub, 'ops-1');
  assert.deepEqual(payload.roles, ['admin']);
  assert.deepEqual(payload.clientIds, ['client-123']);

  const storedKey = `auth-refresh:${body.refreshToken}`;
  assert.equal(config.store.has(storedKey), true);
  const record = JSON.parse(config.store.get(storedKey) ?? '{}') as {
    sessionId: string;
    user: { id: string; email: string; roles: string[]; clientIds: string[] };
  };
  assert.equal(typeof record.sessionId, 'string');
  assert.equal(record.user.id, 'ops-1');
});

test('POST /api/auth/refresh rotates refresh token and reissues JWT', async () => {
  const { env, config } = createEnv();
  const existingToken = 'cafebabe'.repeat(8);
  const storedRecord = {
    sessionId: 'session-123',
    user: {
      id: 'ops-1',
      email: 'ops@example.test',
      name: 'Ops One',
      roles: ['ops'],
      clientIds: ['client-42'],
    },
  };
  await config.put(`auth-refresh:${existingToken}`, JSON.stringify(storedRecord));

  const request = new Request('https://worker.test/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: existingToken }),
  });

  const { ctx } = createCtx();
  const response = await worker.fetch(request, env, ctx);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string; roles: string[]; clientIds: string[] };
  };

  assert.ok(body.refreshToken && body.refreshToken !== existingToken);
  const payload = decodeJwt(body.accessToken);
  assert.equal(payload.sid, 'session-123');
  assert.deepEqual(payload.roles, ['ops']);

  const newKey = `auth-refresh:${body.refreshToken}`;
  assert.equal(config.store.has(newKey), true);
  const nextRecord = JSON.parse(config.store.get(newKey) ?? '{}') as typeof storedRecord;
  assert.equal(nextRecord.sessionId, storedRecord.sessionId);
  assert.deepEqual(nextRecord.user.roles, storedRecord.user.roles);
  assert.equal(config.store.has(`auth-refresh:${existingToken}`), false);
});
