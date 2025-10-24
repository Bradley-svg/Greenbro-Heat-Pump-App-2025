import assert from 'node:assert/strict';
import test from 'node:test';
import { SignJWT } from 'jose';

import worker from '../src/app';
import type { Env, ExecutionContext } from '../src/types/env';

class NullDB {
  prepare(sql: string) {
    return {
      bind() {
        return this;
      },
      async first() {
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        return { success: true };
      },
    };
  }
}

function createEnv(): Env {
  return {
    DB: new NullDB() as unknown as Env['DB'],
    CONFIG: {} as unknown as Env['CONFIG'],
    REPORTS: {} as unknown as Env['REPORTS'],
    BRAND: {} as unknown as Env['BRAND'],
    ARCHIVE: {} as unknown as Env['ARCHIVE'],
    INGEST_Q: {} as unknown as Env['INGEST_Q'],
    DeviceState: {} as unknown as Env['DeviceState'],
    DEVICE_DO: {} as unknown as Env['DEVICE_DO'],
    ACCESS_AUD: 'greenbro-app',
    ACCESS_ISS: 'greenbro-app',
    ACCESS_JWKS: 'https://example.test/jwks.json',
    ACCESS_JWKS_URL: 'https://example.test/jwks.json',
    JWT_SECRET: 'rbac-secret',
    WRITE_MIN_C: undefined,
    WRITE_MAX_C: undefined,
    DEV_AUTH_BYPASS: '0',
    CORS_ALLOWED_ORIGINS: undefined,
    REPORTS_PUBLIC_BASE_URL: undefined,
    BUILD_SHA: undefined,
    BUILD_DATE: undefined,
    BUILD_SOURCE: undefined,
  };
}

function createCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as ExecutionContext;
}

test('RBAC guard denies unauthenticated access', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/api/commissioning/email-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'session-1' }),
  });
  const response = await worker.fetch(request, env, createCtx());
  assert.equal(response.status, 401);
});

test('RBAC guard forbids users without required roles', async () => {
  const env = createEnv();
  const token = await new SignJWT({ roles: ['client'] })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('greenbro-app')
    .setAudience('greenbro-app')
    .setSubject('client-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(env.JWT_SECRET));

  const request = new Request('https://worker.test/api/commissioning/email-report', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ session_id: 'session-1' }),
  });
  try {
    await worker.fetch(request, env, createCtx());
    assert.fail('expected route to reject with 403');
  } catch (error) {
    assert.ok(error instanceof Response);
    assert.equal(error.status, 403);
  }
});
