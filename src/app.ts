import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, IngestMessage, TelemetryPayload } from './types';
import { verifyAccessJWT, requireRole, type AccessContext } from './rbac';
import { handleQueueBatch } from './queue';
import { DeviceStateDO } from './do';

void DeviceStateDO;

type Ctx = { Bindings: Env; Variables: { auth?: AccessContext } };

const app = new Hono<Ctx>();

app.use('*', cors());

app.use('/api/*', async (c, next) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized (missing Access JWT)', 401);
  }

  try {
    const auth = await verifyAccessJWT(c.env, jwt);
    if (auth.roles.length === 0) {
      return c.text('Forbidden (no role)', 403);
    }
    c.set('auth', auth);
    await next();
  } catch (error) {
    console.warn('Invalid Access JWT', error);
    return c.text('Unauthorized (invalid Access JWT)', 401);
  }
});

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/devices/:id/latest', async (c) => {
  const { DB } = c.env;
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }

  if (auth.roles.includes('client') || auth.roles.includes('contractor')) {
    if (!auth.clientIds || auth.clientIds.length === 0) {
      return c.text('Forbidden', 403);
    }
  }

  const id = c.req.param('id');
  const row = await DB.prepare('SELECT * FROM latest_state WHERE device_id=?')
    .bind(id)
    .first();

  return row ? c.json(row) : c.text('Not found', 404);
});

app.post('/api/devices/:id/write', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const deviceId = c.req.param('id');
  const body = await c.req.json<{ dhwSetC?: number; mode?: string }>();

  const id = c.env.DeviceState.idFromName(deviceId);
  const stub = c.env.DeviceState.get(id);

  const res = await stub.fetch('https://do/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId,
      actor: auth.email ?? auth.sub,
      command: body,
      limits: {
        minC: Number(c.env.WRITE_MIN_C ?? '40'),
        maxC: Number(c.env.WRITE_MAX_C ?? '60'),
      },
    }),
  });

  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/api/ingest/:profileId', async (c) => {
  const { DB, INGEST_QUEUE } = c.env;
  const profileId = c.req.param('profileId');
  const body = await c.req.json<TelemetryPayload>();

  if (!body?.deviceId || !body?.ts) {
    return c.text('Bad Request', 400);
  }

  const devKey = c.req.header('X-GREENBRO-DEVICE-KEY');
  if (!devKey) {
    return c.text('Unauthorized (device key missing)', 401);
  }
  const ok = await verifyDeviceKey(DB, body.deviceId, devKey);
  if (!ok) {
    return c.text('Unauthorized (device key invalid)', 401);
  }

  const msg: IngestMessage = { kind: 'telemetry', profileId, body };
  await INGEST_QUEUE.send(msg);
  return c.text('Accepted', 202);
});

app.post('/api/heartbeat/:profileId', async (c) => {
  const { DB, INGEST_QUEUE } = c.env;
  const profileId = c.req.param('profileId');
  const body = await c.req.json<{ deviceId: string; ts: string; rssi?: number }>();

  if (!body?.deviceId || !body?.ts) {
    return c.text('Bad Request', 400);
  }

  const devKey = c.req.header('X-GREENBRO-DEVICE-KEY');
  if (!devKey) {
    return c.text('Unauthorized (device key missing)', 401);
  }
  const ok = await verifyDeviceKey(DB, body.deviceId, devKey);
  if (!ok) {
    return c.text('Unauthorized (device key invalid)', 401);
  }

  const msg: IngestMessage = { kind: 'heartbeat', profileId, body };
  await INGEST_QUEUE.send(msg);
  return c.text('Accepted', 202);
});

async function verifyDeviceKey(
  DB: D1Database,
  deviceId: string,
  providedKey: string,
): Promise<boolean> {
  const enc = new TextEncoder();
  const data = enc.encode(providedKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const row = await DB.prepare('SELECT device_key_hash FROM devices WHERE device_id=?')
    .bind(deviceId)
    .first<{ device_key_hash: string }>();
  return row?.device_key_hash === hex;
}

export default {
  fetch: app.fetch,
  queue: handleQueueBatch,
  scheduled: async (_ctrl: ScheduledController, _env: Env, _ctx: ExecutionContext) => {
    // Placeholder for scheduled tasks such as escalations or key rotations
  },
};
