import { Hono } from 'hono';
import type { Context } from 'hono';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';

interface TelemetryPayload {
  deviceId: string;
  timestamp: string;
  metrics: Record<string, number>;
}

interface CommandPayload {
  setpointC: number;
  reason?: string;
}

type QueueMessage =
  | ({ type: 'telemetry'; receivedAt: string } & TelemetryPayload)
  | ({ type: 'command'; issuedAt: string } & { deviceId: string; setpointC: number; reason?: string });

type Env = {
  DB: D1Database;
  CONFIG: KVNamespace;
  REPORTS: R2Bucket;
  INGEST_QUEUE: Queue<QueueMessage>;
  DeviceState: DurableObjectNamespace<DeviceStateDO>;
  ACCESS_JWKS_URL: string;
  ACCESS_AUD: string;
  WRITE_MIN_C?: string;
  WRITE_MAX_C?: string;
};

type Variables = {
  token?: JWTPayload;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function parseTelemetry(body: unknown): TelemetryPayload {
  if (!body || typeof body !== 'object') {
    throw new Error('Body must be an object');
  }

  const { deviceId, timestamp, metrics } = body as Record<string, unknown>;
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('deviceId is required');
  }
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    throw new Error('timestamp must be an ISO string');
  }
  if (!metrics || typeof metrics !== 'object') {
    throw new Error('metrics must be an object');
  }

  const normalizedMetrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`metric ${key} must be a number`);
    }
    normalizedMetrics[key] = value;
  }

  return {
    deviceId,
    timestamp,
    metrics: normalizedMetrics,
  };
}

function parseCommand(body: unknown, env: Env): CommandPayload {
  if (!body || typeof body !== 'object') {
    throw new Error('Body must be an object');
  }

  const { setpointC, reason } = body as Record<string, unknown>;
  if (typeof setpointC !== 'number' || Number.isNaN(setpointC)) {
    throw new Error('setpointC must be a number');
  }
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error('reason must be a string when provided');
  }

  const min = env.WRITE_MIN_C ? Number(env.WRITE_MIN_C) : 35;
  const max = env.WRITE_MAX_C ? Number(env.WRITE_MAX_C) : 65;
  if (Number.isNaN(min) || Number.isNaN(max)) {
    throw new Error('Invalid min/max configuration');
  }
  if (setpointC < min || setpointC > max) {
    throw new Error(`setpointC must be between ${min} and ${max}`);
  }

  return {
    setpointC,
    reason: reason as string | undefined,
  };
}

async function requireAccessToken(c: Context<{ Bindings: Env; Variables: Variables }>, next: () => Promise<void>) {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return c.json({ error: 'Missing bearer token' }, 401);
  }

  const token = header.slice('Bearer '.length);
  try {
    const jwks = await getJwks(c.env);
    const { payload } = await jwtVerify(token, jwks, {
      audience: c.env.ACCESS_AUD,
    });
    c.set('token', payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid token';
    return c.json({ error: message }, 401);
  }

  await next();
}

async function getJwks(env: Env) {
  if (!env.ACCESS_JWKS_URL) {
    throw new Error('ACCESS_JWKS_URL not configured');
  }
  let jwks = jwksCache.get(env.ACCESS_JWKS_URL);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(env.ACCESS_JWKS_URL));
    jwksCache.set(env.ACCESS_JWKS_URL, jwks);
  }
  return jwks;
}

app.get('/health', async (c) => {
  try {
    const row = await c.env.DB.prepare('SELECT 1 as ok').first<{ ok: number }>();
    return c.json({ status: 'ok', db: row?.ok === 1 ? 'reachable' : 'unknown' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Database error';
    return c.json({ status: 'degraded', error: message }, 500);
  }
});

app.post('/v1/telemetry', async (c) => {
  let telemetry: TelemetryPayload;
  try {
    const body = await c.req.json();
    telemetry = parseTelemetry(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid payload';
    return c.json({ error: message }, 400);
  }

  const queueMessage: QueueMessage = {
    type: 'telemetry',
    deviceId: telemetry.deviceId,
    timestamp: telemetry.timestamp,
    metrics: telemetry.metrics,
    receivedAt: new Date().toISOString(),
  };

  await c.env.INGEST_QUEUE.send(queueMessage);

  const id = c.env.DeviceState.idFromName(telemetry.deviceId);
  const stub = c.env.DeviceState.get(id);
  c.executionCtx.waitUntil(
    stub.fetch('https://device-state.internal/state', {
      method: 'PUT',
      body: JSON.stringify({ telemetry }),
      headers: { 'content-type': 'application/json' },
    })
  );

  return c.json({ status: 'queued' }, 202);
});

app.get('/v1/devices/:id/latest', requireAccessToken, async (c) => {
  const deviceId = c.req.param('id');
  try {
    const latest = await c.env.DB.prepare(
      `SELECT device_id as deviceId, temperature_c as temperatureC, pressure_pa as pressurePa, humidity_percent as humidityPercent, updated_at as updatedAt
       FROM device_latest
       WHERE device_id = ?`
    )
      .bind(deviceId)
      .first<Record<string, unknown>>();

    if (!latest) {
      return c.json({ error: 'Device not found' }, 404);
    }

    return c.json(latest);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Query failed';
    return c.json({ error: message }, 500);
  }
});

app.post('/v1/devices/:id/setpoint', requireAccessToken, async (c) => {
  const deviceId = c.req.param('id');
  let command: CommandPayload;
  try {
    const body = await c.req.json();
    command = parseCommand(body, c.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid payload';
    return c.json({ error: message }, 400);
  }

  const queueMessage: QueueMessage = {
    type: 'command',
    deviceId,
    setpointC: command.setpointC,
    reason: command.reason,
    issuedAt: new Date().toISOString(),
  };

  await c.env.INGEST_QUEUE.send(queueMessage);

  const audit = JSON.stringify({
    deviceId,
    setpointC: command.setpointC,
    reason: command.reason ?? null,
    issuedAt: queueMessage.issuedAt,
    actor: c.get('token')?.sub ?? 'unknown',
  });

  await c.env.DB.prepare(
    `INSERT INTO device_commands (device_id, setpoint_c, reason, actor_sub, created_at, payload_json)
     VALUES (?, ?, ?, ?, datetime('now'), ?)`
  )
    .bind(deviceId, command.setpointC, command.reason ?? null, c.get('token')?.sub ?? null, audit)
    .run();

  return c.json({ status: 'queued' }, 202);
});

app.get('/v1/devices/:id/state', requireAccessToken, async (c) => {
  const deviceId = c.req.param('id');
  const id = c.env.DeviceState.idFromName(deviceId);
  const stub = c.env.DeviceState.get(id);
  const response = await stub.fetch('https://device-state.internal/state');
  if (!response.ok) {
    return c.json({ error: 'State not available' }, response.status);
  }
  return response;
});

export const appFetch = app.fetch;

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext) {
    for (const message of batch.messages) {
      try {
        if (message.body.type === 'telemetry') {
          await handleTelemetryMessage(message.body, env, ctx);
        } else if (message.body.type === 'command') {
          await handleCommandMessage(message.body, env, ctx);
        }
        message.ack();
      } catch (error) {
        console.error('Failed to process queue message', error);
        message.retry();
      }
    }
  },
};

async function handleTelemetryMessage(message: Extract<QueueMessage, { type: 'telemetry' }>, env: Env, ctx: ExecutionContext) {
  const payload = JSON.stringify({ metrics: message.metrics, timestamp: message.timestamp });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO device_telemetry (device_id, observed_at, received_at, payload_json)
       VALUES (?, datetime(?), datetime(?), ?)`
    ).bind(message.deviceId, message.timestamp, message.receivedAt, payload),
    env.DB.prepare(
      `INSERT INTO device_latest (device_id, temperature_c, humidity_percent, pressure_pa, updated_at)
       VALUES (?, ?, ?, ?, datetime(?))
       ON CONFLICT(device_id) DO UPDATE SET
         temperature_c = excluded.temperature_c,
         humidity_percent = excluded.humidity_percent,
         pressure_pa = excluded.pressure_pa,
         updated_at = excluded.updated_at`
    ).bind(
      message.deviceId,
      message.metrics.temperature_c ?? null,
      message.metrics.humidity_percent ?? null,
      message.metrics.pressure_pa ?? null,
      message.timestamp
    ),
  ]);

  const id = env.DeviceState.idFromName(message.deviceId);
  const stub = env.DeviceState.get(id);
  ctx.waitUntil(
    stub.fetch('https://device-state.internal/state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetry: message }),
    })
  );
}

async function handleCommandMessage(message: Extract<QueueMessage, { type: 'command' }>, env: Env, ctx: ExecutionContext) {
  await env.DB.prepare(
    `INSERT INTO device_command_queue (device_id, setpoint_c, reason, issued_at)
     VALUES (?, ?, ?, datetime(?))`
  ).bind(message.deviceId, message.setpointC, message.reason ?? null, message.issuedAt)
    .run();

  const id = env.DeviceState.idFromName(message.deviceId);
  const stub = env.DeviceState.get(id);
  ctx.waitUntil(
    stub.fetch('https://device-state.internal/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setpointC: message.setpointC, reason: message.reason, issuedAt: message.issuedAt }),
    })
  );
}

interface DeviceStateSnapshot {
  telemetry?: TelemetryPayload & { receivedAt?: string };
  pendingCommands: Array<{ setpointC: number; issuedAt: string; reason?: string }>;
}

export class DeviceStateDO {
  private state: DurableObjectState;
  private cache: DeviceStateSnapshot = { pendingCommands: [] };
  private ready: Promise<void>;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<DeviceStateSnapshot>('latest');
      if (stored) {
        this.cache = stored;
      }
    });
  }

  async fetch(request: Request) {
    await this.ready;
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/state') {
      return new Response(JSON.stringify(this.cache), { headers: { 'content-type': 'application/json' } });
    }

    if (request.method === 'PUT' && url.pathname === '/state') {
      const body = (await request.json()) as { telemetry: TelemetryPayload & { receivedAt?: string } };
      this.cache.telemetry = body.telemetry;
      await this.persist();
      return new Response('ok');
    }

    if (request.method === 'POST' && url.pathname === '/commands') {
      const body = (await request.json()) as { setpointC: number; issuedAt: string; reason?: string };
      this.cache.pendingCommands.push(body);
      await this.persist();
      return new Response('queued', { status: 202 });
    }

    if (request.method === 'DELETE' && url.pathname === '/commands') {
      this.cache.pendingCommands = [];
      await this.persist();
      return new Response('cleared');
    }

    return new Response('Not found', { status: 404 });
  }

  private async persist() {
    await this.state.storage.put('latest', this.cache);
  }
}
