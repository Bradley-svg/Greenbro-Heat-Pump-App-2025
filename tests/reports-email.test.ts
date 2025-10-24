import assert from 'node:assert/strict';
import test from 'node:test';

import { generateCommissioningPDF } from '../src/pdf';
import { emailCommissioning } from '../src/lib/email';
import type { Env } from '../src/types/env';

class BucketStub {
  puts: Array<{ key: string; value: Uint8Array | string; options?: unknown }> = [];
  async put(key: string, value: Uint8Array | string, options?: unknown) {
    this.puts.push({ key, value, options });
  }
  async createSignedUrl({ key }: { key: string }) {
    return new URL(`https://reports.example/${encodeURIComponent(key)}`);
  }
}

class SettingsDB {
  values = new Map<string, string>();
  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) {
      this.values.set(key, value);
    }
  }
  prepare(sql: string) {
    const db = this;
    return {
      bind(key: string) {
        return {
          async first<T>() {
            if (sql.startsWith('SELECT value FROM settings WHERE key=?')) {
              const value = db.values.get(key) ?? null;
              return (value == null ? null : ({ value } as T));
            }
            if (sql.includes("WHERE session_id=? AND kind='pdf'")) {
              return ({ r2_key: 'commissioning/report.pdf' } as unknown) as T;
            }
            if (sql.includes("WHERE session_id=? AND kind='zip'")) {
              return ({ r2_key: 'commissioning/bundle.zip' } as unknown) as T;
            }
            return null;
          },
        };
      },
    };
  }
}

test('generateCommissioningPDF stores PDF bytes in REPORTS bucket', async () => {
  const bucket = new BucketStub();
  const env = { REPORTS: bucket } as unknown as Env;

  const result = await generateCommissioningPDF(env, {
    deviceId: 'HP-200',
    site: 'Cape Town HQ',
    performedBy: 'Installer Jane',
    ts: '2024-01-15T10:20:30Z',
    checklist: [],
    measurements: { 'Delta T': '8 C', Flow: '0.7 L/s' },
  });

  assert.ok(result.key.startsWith('commissioning/HP-200/2024-01-15T10-20-30Z'));
  assert.equal(result.url.startsWith('/api/reports/'), true);
  assert.equal(bucket.puts.length, 1);
  const write = bucket.puts[0];
  assert.equal(write.key, result.key);
  assert.ok(write.value instanceof Uint8Array);
  assert.deepEqual((write.options as { httpMetadata?: { contentType?: string } }).httpMetadata?.contentType, 'application/pdf');
});

test('emailCommissioning posts to webhook with signed report URL', async () => {
  const bucket = new BucketStub();
  const db = new SettingsDB({ ops_webhook_url: 'https://hooks.example/ops' });
  const env: Env = {
    DB: db as unknown as Env['DB'],
    REPORTS: bucket as unknown as Env['REPORTS'],
    CONFIG: {} as unknown as Env['CONFIG'],
    BRAND: {} as unknown as Env['BRAND'],
    ARCHIVE: {} as unknown as Env['ARCHIVE'],
    INGEST_Q: {} as unknown as Env['INGEST_Q'],
    DeviceState: {} as unknown as Env['DeviceState'],
    DEVICE_DO: {} as unknown as Env['DEVICE_DO'],
    ACCESS_AUD: 'aud',
    ACCESS_ISS: 'iss',
    JWT_SECRET: 'email-secret',
    WRITE_MIN_C: undefined,
    WRITE_MAX_C: undefined,
    DEV_AUTH_BYPASS: '0',
    CORS_ALLOWED_ORIGINS: undefined,
    REPORTS_PUBLIC_BASE_URL: 'https://cdn.greenbro.test',
    BUILD_SHA: undefined,
    BUILD_DATE: undefined,
    BUILD_SOURCE: undefined,
  };

  const calls: Array<{ url: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const res = await emailCommissioning(env, 'ops@example.test', 'Commissioning Report', 'Session ready', 'commissioning/report.pdf');
    assert.deepEqual(res, { ok: true as const });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const [request] = calls;
  assert.equal(request.url, 'https://hooks.example/ops');
  const payload = JSON.parse(request.body) as { text: string };
  assert.ok(payload.text.includes('Commissioning Report'));
  assert.ok(payload.text.includes('Session ready'));
  assert.ok(payload.text.includes('Recipients: ops@example.test'));
  assert.ok(payload.text.includes('https://reports.example/commissioning%2Freport.pdf'));
});
