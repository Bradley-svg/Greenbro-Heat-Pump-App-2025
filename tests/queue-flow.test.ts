import assert from 'node:assert/strict';
import test from 'node:test';

import { handleQueueBatch } from '../src/queue';
import type { Env, ExecutionContext, MessageBatch } from '../src/types/env';
import type { IngestMessage, TelemetryPayload } from '../src/types';

class MockQueueStatement {
  #sql: string;
  #db: MockQueueDB;
  #args: unknown[] = [];

  constructor(sql: string, db: MockQueueDB) {
    this.#sql = sql;
    this.#db = db;
  }

  bind(...args: unknown[]) {
    this.#args = args;
    return this;
  }

  async run() {
    this.#db.record({ sql: this.#sql, args: this.#args, mode: 'run' });
    return { success: true };
  }

  async first<T>() {
    this.#db.record({ sql: this.#sql, args: this.#args, mode: 'first' });
    return null as unknown as T;
  }

  async all<T>() {
    this.#db.record({ sql: this.#sql, args: this.#args, mode: 'all' });
    return { results: [] } as unknown as T;
  }
}

class MockQueueDB {
  calls: Array<{ sql: string; args: unknown[]; mode: string }> = [];

  prepare(sql: string) {
    return new MockQueueStatement(sql, this);
  }

  record(entry: { sql: string; args: unknown[]; mode: string }) {
    this.calls.push(entry);
  }
}

test('telemetry batch persists readings, updates latest, and dispatches to DO', async () => {
  const db = new MockQueueDB();
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  const waitPromises: Promise<unknown>[] = [];

  const env: Env = {
    DB: db as unknown as Env['DB'],
    CONFIG: {} as unknown as Env['CONFIG'],
    REPORTS: {} as unknown as Env['REPORTS'],
    BRAND: {} as unknown as Env['BRAND'],
    ARCHIVE: {} as unknown as Env['ARCHIVE'],
    INGEST_Q: {} as unknown as Env['INGEST_Q'],
    DeviceState: {
      idFromName: (name: string) => `do:${name}`,
      get: () => ({
        async fetch(url: string, init?: RequestInit) {
          const raw = init?.body ? JSON.parse(String(init.body)) : null;
          fetchCalls.push({ url, body: raw });
          return new Response(null, { status: url.endsWith('/append') ? 200 : 204 });
        },
      }),
    } as unknown as Env['DeviceState'],
    DEVICE_DO: {} as unknown as Env['DEVICE_DO'],
    ACCESS_AUD: 'greenbro-app',
    ACCESS_ISS: 'greenbro-app',
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

  const ctx: ExecutionContext = {
    waitUntil(promise: Promise<unknown>) {
      waitPromises.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;

  const telemetry: TelemetryPayload = {
    deviceId: 'HP-100',
    ts: '2024-01-01T00:00:00Z',
    metrics: {
      tankC: 52,
      supplyC: 48,
      returnC: 40,
      ambientC: 18,
      flowLps: 0.7,
      compCurrentA: 9.5,
      eevSteps: 120,
      powerKW: 2.4,
    },
    status: { mode: 'heat', defrost: false, online: true },
    faults: [{ code: 'F0', active: false }],
  };

  let acked = false;
  let retried = false;
  const batch: MessageBatch<IngestMessage> = {
    queue: {} as any,
    messages: [
      {
        id: 'm-1',
        timestamp: Date.now(),
        attempts: 0,
        ack() {
          acked = true;
        },
        retry() {
          retried = true;
        },
        body: { type: 'telemetry', body: telemetry },
      },
    ],
  } as MessageBatch<IngestMessage>;

  await handleQueueBatch(batch, env, ctx);
  await Promise.all(waitPromises);

  assert.equal(acked, true);
  assert.equal(retried, false);

  const insertTelemetry = db.calls.some((call) => call.sql.startsWith('INSERT OR REPLACE INTO telemetry'));
  assert.equal(insertTelemetry, true);
  const upsertLatest = db.calls.some((call) => call.sql.includes('INSERT INTO latest_state'));
  assert.equal(upsertLatest, true);
  const metricsLogged = db.calls.some((call) => call.sql.startsWith('INSERT INTO ops_metrics'));
  assert.equal(metricsLogged, true);

  assert.equal(fetchCalls.length, 2);
  const statePayload = fetchCalls.find((entry) => entry.url === 'https://do/telemetry');
  assert.ok(statePayload);
  assert.equal((statePayload!.body as { telemetry: TelemetryPayload }).telemetry.deviceId, 'HP-100');

  const appendPayload = fetchCalls.find((entry) => entry.url === 'https://do/append');
  assert.ok(appendPayload);
  const appendBody = appendPayload!.body as { delta_t: number | null; cop: number | null };
  assert.equal(typeof appendBody.delta_t, 'number');
  assert.equal('cop' in appendBody, true);
});
