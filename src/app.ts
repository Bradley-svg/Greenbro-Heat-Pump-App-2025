import { Hono } from 'hono';
import type { Context } from 'hono';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';

interface TelemetryPayload {
  deviceId: string;
  timestamp: string;
  metrics: Record<string, number>;
  status?: Record<string, unknown>;
  faults?: unknown;
}

interface CommandPayload {
  setpointC: number;
  reason?: string;
}

type QueueMessage =
  | ({ type: 'telemetry'; receivedAt: string } & TelemetryPayload)
  | ({ type: 'command'; issuedAt: string; writeId: string } & { deviceId: string; setpointC: number; reason?: string });

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

  const { deviceId, timestamp, metrics, status, faults } = body as Record<string, unknown>;
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

  let normalizedStatus: Record<string, unknown> | undefined;
  if (status !== undefined) {
    if (!status || typeof status !== 'object' || Array.isArray(status)) {
      throw new Error('status must be an object when provided');
    }
    normalizedStatus = { ...(status as Record<string, unknown>) };
  }

  let normalizedFaults: unknown;
  if (faults !== undefined) {
    if (typeof faults !== 'object' || faults === null) {
      throw new Error('faults must be an object or array when provided');
    }
    normalizedFaults = faults;
  }

  return {
    deviceId,
    timestamp,
    metrics: normalizedMetrics,
    status: normalizedStatus,
    faults: normalizedFaults,
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
    status: telemetry.status,
    faults: telemetry.faults,
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
      `SELECT
         device_id as deviceId,
         ts,
         supplyC,
         returnC,
         tankC,
         ambientC,
         flowLps,
         compCurrentA,
         eevSteps,
         powerKW,
         deltaT,
         thermalKW,
         cop,
         cop_quality as copQuality,
         mode,
         defrost,
         online,
         faults_json as faultsJson,
         updated_at as updatedAt
       FROM latest_state
       WHERE device_id = ?`
    )
      .bind(deviceId)
      .first<{
        deviceId: string;
        ts: string;
        supplyC: number | null;
        returnC: number | null;
        tankC: number | null;
        ambientC: number | null;
        flowLps: number | null;
        compCurrentA: number | null;
        eevSteps: number | null;
        powerKW: number | null;
        deltaT: number | null;
        thermalKW: number | null;
        cop: number | null;
        copQuality: string | null;
        mode: string | null;
        defrost: number | null;
        online: number | null;
        faultsJson: string | null;
        updatedAt: string;
      }>();

    if (!latest) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const { faultsJson, ...rest } = latest;
    return c.json({
      ...rest,
      faults: faultsJson ? JSON.parse(faultsJson) : null,
    });
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

  const issuedAt = new Date().toISOString();
  const writeId = crypto.randomUUID();
  const queueMessage: QueueMessage = {
    type: 'command',
    deviceId,
    setpointC: command.setpointC,
    reason: command.reason,
    issuedAt,
    writeId,
  };

  await c.env.INGEST_QUEUE.send(queueMessage);

  const actor = c.get('token')?.sub ?? 'unknown';
  const afterJson = JSON.stringify({
    setpointC: command.setpointC,
    reason: command.reason ?? null,
  });

  await c.env.DB.prepare(
    `INSERT INTO writes (id, device_id, ts, actor, before_json, after_json, clamped_json, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(writeId, deviceId, issuedAt, actor, null, afterJson, null, 'queued')
    .run();

  return c.json({ status: 'queued', writeId }, 202);
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
  const metricsJson = JSON.stringify(message.metrics);
  const statusJson = message.status ? JSON.stringify(message.status) : null;
  const faultsJson = message.faults ? JSON.stringify(message.faults) : null;

  const getMetric = (key: string): number | null => {
    const value = (message.metrics as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  const supplyC = getMetric('supplyC');
  const returnC = getMetric('returnC');
  const tankC = getMetric('tankC');
  const ambientC = getMetric('ambientC');
  const flowLps = getMetric('flowLps');
  const compCurrentA = getMetric('compCurrentA');
  const eevSteps = getMetric('eevSteps');
  const powerKW = getMetric('powerKW');

  const deltaT = supplyC !== null && returnC !== null ? supplyC - returnC : null;
  const thermalKW = deltaT !== null && flowLps !== null ? flowLps * deltaT * 4.186 : null;
  const cop = thermalKW !== null && powerKW !== null && powerKW > 0 ? thermalKW / powerKW : null;
  const copQuality = cop !== null ? 'calculated' : 'insufficient_data';

  const statusRecord = message.status as Record<string, unknown> | undefined;
  const mode = typeof statusRecord?.mode === 'string' ? (statusRecord.mode as string) : null;
  const deriveFlag = (value: unknown): number | null => {
    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    if (typeof value === 'number') {
      return value !== 0 ? 1 : 0;
    }
    return null;
  };
  const defrost = deriveFlag(statusRecord?.defrost);
  const online = deriveFlag(statusRecord?.online ?? statusRecord?.isOnline) ?? 1;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO telemetry (device_id, ts, metrics_json, deltaT, thermalKW, cop, cop_quality, status_json, faults_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(message.deviceId, message.timestamp, metricsJson, deltaT, thermalKW, cop, copQuality, statusJson, faultsJson),
    env.DB.prepare(
      `INSERT INTO latest_state (
         device_id, ts, supplyC, returnC, tankC, ambientC, flowLps, compCurrentA, eevSteps, powerKW, deltaT, thermalKW, cop, cop_quality, mode, defrost, online, faults_json, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(device_id) DO UPDATE SET
         ts = excluded.ts,
         supplyC = excluded.supplyC,
         returnC = excluded.returnC,
         tankC = excluded.tankC,
         ambientC = excluded.ambientC,
         flowLps = excluded.flowLps,
         compCurrentA = excluded.compCurrentA,
         eevSteps = excluded.eevSteps,
         powerKW = excluded.powerKW,
         deltaT = excluded.deltaT,
         thermalKW = excluded.thermalKW,
         cop = excluded.cop,
         cop_quality = excluded.cop_quality,
         mode = excluded.mode,
         defrost = excluded.defrost,
         online = excluded.online,
         faults_json = excluded.faults_json,
         updated_at = excluded.updated_at`
    ).bind(
      message.deviceId,
      message.timestamp,
      supplyC,
      returnC,
      tankC,
      ambientC,
      flowLps,
      compCurrentA,
      eevSteps,
      powerKW,
      deltaT,
      thermalKW,
      cop,
      copQuality,
      mode,
      defrost,
      online,
      faultsJson
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
  await env.DB.prepare(`UPDATE writes SET result = ? WHERE id = ?`)
    .bind('dispatching', message.writeId)
    .run();

  const id = env.DeviceState.idFromName(message.deviceId);
  const stub = env.DeviceState.get(id);
  const response = await stub.fetch('https://device-state.internal/commands', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      setpointC: message.setpointC,
      reason: message.reason,
      issuedAt: message.issuedAt,
      writeId: message.writeId,
    }),
  });

  if (!response.ok) {
    await env.DB.prepare(`UPDATE writes SET result = ? WHERE id = ?`)
      .bind(`failed:${response.status}`, message.writeId)
      .run();
    throw new Error(`Device command dispatch failed with status ${response.status}`);
  }

  ctx.waitUntil(
    env.DB.prepare(`UPDATE writes SET result = ? WHERE id = ?`)
      .bind('dispatched', message.writeId)
      .run()
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
