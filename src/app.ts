import { Hono } from 'hono';
import type { Context } from 'hono';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import type { Env as BaseEnv, TelemetryPayload } from './types';

interface CommandPayload {
  setpointC: number;
  reason?: string;
}

type TelemetryQueueMessage = {
  kind: 'telemetry';
  receivedAt: string;
  body: TelemetryPayload;
};

type CommandQueueMessage = {
  kind: 'command';
  issuedAt: string;
  writeId: string;
  deviceId: string;
  setpointC: number;
  reason?: string;
};

type QueueMessage = TelemetryQueueMessage | CommandQueueMessage;

type Env = Omit<BaseEnv, 'INGEST_QUEUE' | 'DeviceState' | 'WRITE_MIN_C' | 'WRITE_MAX_C'> & {
  INGEST_QUEUE: Queue<QueueMessage>;
  DeviceState: DurableObjectNamespace<DeviceStateDO>;
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

  const { deviceId, ts, timestamp, metrics, status, faults, derived } = body as Record<string, unknown>;
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
    throw new Error('deviceId is required');
  }
  const tsValue = typeof ts === 'string' ? ts : typeof timestamp === 'string' ? timestamp : undefined;
  const normalizedTs = typeof tsValue === 'string' ? tsValue.trim() : undefined;
  if (!normalizedTs || normalizedTs.length === 0 || Number.isNaN(Date.parse(normalizedTs))) {
    throw new Error('ts must be an ISO string');
  }
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error('metrics must be an object');
  }

  const metricKeys = ['tankC', 'supplyC', 'returnC', 'ambientC', 'flowLps', 'compCurrentA', 'eevSteps', 'powerKW'] as const;
  const normalizedMetrics: TelemetryPayload['metrics'] = {};
  for (const key of metricKeys) {
    const value = (metrics as Record<string, unknown>)[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`metric ${key} must be a number`);
    }
    normalizedMetrics[key] = value;
  }

  let normalizedStatus: TelemetryPayload['status'];
  if (status !== undefined) {
    if (!status || typeof status !== 'object' || Array.isArray(status)) {
      throw new Error('status must be an object when provided');
    }
    const statusRecord = status as Record<string, unknown>;
    const candidate: TelemetryPayload['status'] = {};
    if (statusRecord.mode !== undefined) {
      if (typeof statusRecord.mode !== 'string' || statusRecord.mode.trim().length === 0) {
        throw new Error('status.mode must be a string when provided');
      }
      candidate.mode = statusRecord.mode;
    }
    if (statusRecord.defrost !== undefined) {
      if (typeof statusRecord.defrost !== 'boolean') {
        throw new Error('status.defrost must be a boolean when provided');
      }
      candidate.defrost = statusRecord.defrost;
    }
    if (statusRecord.online !== undefined) {
      if (typeof statusRecord.online !== 'boolean') {
        throw new Error('status.online must be a boolean when provided');
      }
      candidate.online = statusRecord.online;
    }
    if (Object.keys(candidate).length > 0) {
      normalizedStatus = candidate;
    }
  }

  let normalizedFaults: TelemetryPayload['faults'];
  if (faults !== undefined) {
    if (!Array.isArray(faults)) {
      throw new Error('faults must be an array when provided');
    }
    normalizedFaults = faults.map((fault, index) => {
      if (!fault || typeof fault !== 'object') {
        throw new Error(`faults[${index}] must be an object`);
      }
      const faultRecord = fault as Record<string, unknown>;
      if (typeof faultRecord.code !== 'string' || faultRecord.code.trim().length === 0) {
        throw new Error(`faults[${index}].code must be a string`);
      }
      if (typeof faultRecord.active !== 'boolean') {
        throw new Error(`faults[${index}].active must be a boolean`);
      }
      return { code: faultRecord.code, active: faultRecord.active };
    });
  }

  let normalizedDerived: TelemetryPayload['derived'];
  if (derived !== undefined) {
    if (!derived || typeof derived !== 'object' || Array.isArray(derived)) {
      throw new Error('derived must be an object when provided');
    }
    const derivedRecord = derived as Record<string, unknown>;
    const candidate: TelemetryPayload['derived'] = {};
    if (derivedRecord.deltaT !== undefined) {
      if (typeof derivedRecord.deltaT !== 'number' || Number.isNaN(derivedRecord.deltaT)) {
        throw new Error('derived.deltaT must be a number when provided');
      }
      candidate.deltaT = derivedRecord.deltaT;
    }
    if (derivedRecord.thermalKW !== undefined) {
      if (typeof derivedRecord.thermalKW !== 'number' || Number.isNaN(derivedRecord.thermalKW)) {
        throw new Error('derived.thermalKW must be a number when provided');
      }
      candidate.thermalKW = derivedRecord.thermalKW;
    }
    if (derivedRecord.cop !== undefined) {
      if (typeof derivedRecord.cop !== 'number' || Number.isNaN(derivedRecord.cop)) {
        throw new Error('derived.cop must be a number when provided');
      }
      candidate.cop = derivedRecord.cop;
    }
    if (derivedRecord.copQuality !== undefined) {
      if (derivedRecord.copQuality !== 'measured' && derivedRecord.copQuality !== 'estimated') {
        throw new Error("derived.copQuality must be 'measured' or 'estimated' when provided");
      }
      candidate.copQuality = derivedRecord.copQuality;
    }
    if (Object.keys(candidate).length > 0) {
      normalizedDerived = candidate;
    }
  }

  return {
    deviceId: deviceId.trim(),
    ts: normalizedTs,
    metrics: normalizedMetrics,
    status: normalizedStatus,
    faults: normalizedFaults,
    derived: normalizedDerived,
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
    kind: 'telemetry',
    receivedAt: new Date().toISOString(),
    body: telemetry,
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
    kind: 'command',
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
        if (message.body.kind === 'telemetry') {
          await handleTelemetryMessage(message.body, env, ctx);
        } else if (message.body.kind === 'command') {
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

async function handleTelemetryMessage(message: Extract<QueueMessage, { kind: 'telemetry' }>, env: Env, ctx: ExecutionContext) {
  const telemetry = message.body;
  const metricsJson = JSON.stringify(telemetry.metrics);
  const statusJson = telemetry.status ? JSON.stringify(telemetry.status) : null;
  const faultsJson = telemetry.faults ? JSON.stringify(telemetry.faults) : null;

  const getMetric = <K extends keyof TelemetryPayload['metrics']>(key: K): number | null => {
    const value = telemetry.metrics[key];
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
  const copQuality = cop !== null ? telemetry.derived?.copQuality ?? 'estimated' : telemetry.derived?.copQuality ?? null;

  const statusRecord = telemetry.status;
  const mode = statusRecord?.mode ?? null;
  const defrost = typeof statusRecord?.defrost === 'boolean' ? (statusRecord.defrost ? 1 : 0) : null;
  const online = typeof statusRecord?.online === 'boolean' ? (statusRecord.online ? 1 : 0) : 1;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO telemetry (device_id, ts, metrics_json, deltaT, thermalKW, cop, cop_quality, status_json, faults_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(telemetry.deviceId, telemetry.ts, metricsJson, deltaT, thermalKW, cop, copQuality, statusJson, faultsJson),
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
      telemetry.deviceId,
      telemetry.ts,
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

  const id = env.DeviceState.idFromName(telemetry.deviceId);
  const stub = env.DeviceState.get(id);
  ctx.waitUntil(
    stub.fetch('https://device-state.internal/state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetry: { ...telemetry, receivedAt: message.receivedAt } }),
    })
  );
}

async function handleCommandMessage(message: Extract<QueueMessage, { kind: 'command' }>, env: Env, ctx: ExecutionContext) {
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
