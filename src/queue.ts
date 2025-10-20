import type { Env, IngestMessage, TelemetryPayload } from './types';

interface TelemetryContext {
  telemetry: TelemetryPayload;
  receivedAt: string;
}

interface HeartbeatContext {
  deviceId: string;
  ts: string;
  rssi?: number;
  receivedAt: string;
}

export async function handleQueueBatch(
  batch: MessageBatch<IngestMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (message.body.kind === 'telemetry') {
        await handleTelemetry(env, ctx, {
          telemetry: sanitizeTelemetry(message.body.body),
          receivedAt: new Date().toISOString(),
        });
      } else if (message.body.kind === 'heartbeat') {
        await handleHeartbeat(env, ctx, {
          deviceId: message.body.body.deviceId,
          ts: message.body.body.ts,
          rssi: message.body.body.rssi,
          receivedAt: new Date().toISOString(),
        });
      }
      message.ack();
    } catch (error) {
      console.error('Failed to process queue message', error);
      message.retry();
    }
  }
}

function sanitizeTelemetry(input: TelemetryPayload): TelemetryPayload {
  const metrics = { ...input.metrics };
  const coerceNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  return {
    deviceId: input.deviceId,
    ts: input.ts,
    metrics: {
      tankC: coerceNumber(metrics.tankC),
      supplyC: coerceNumber(metrics.supplyC),
      returnC: coerceNumber(metrics.returnC),
      ambientC: coerceNumber(metrics.ambientC),
      flowLps: coerceNumber(metrics.flowLps),
      compCurrentA: coerceNumber(metrics.compCurrentA),
      eevSteps: coerceNumber(metrics.eevSteps),
      powerKW: coerceNumber(metrics.powerKW),
    },
    status: input.status,
    faults: Array.isArray(input.faults)
      ? input.faults
          .map((fault) =>
            fault && typeof fault.code === 'string' && typeof fault.active === 'boolean'
              ? { code: fault.code, active: fault.active }
              : undefined,
          )
          .filter((fault): fault is { code: string; active: boolean } => fault !== undefined)
      : undefined,
    derived: input.derived,
  };
}

async function handleTelemetry(env: Env, ctx: ExecutionContext, context: TelemetryContext): Promise<void> {
  const { telemetry, receivedAt } = context;

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
  const thermalKW =
    deltaT !== null && flowLps !== null ? Number((flowLps * deltaT * 4.186).toFixed(3)) : null;
  const cop =
    thermalKW !== null && powerKW !== null && powerKW > 0
      ? Number((thermalKW / powerKW).toFixed(3))
      : null;
  const copQuality = cop !== null ? telemetry.derived?.copQuality ?? 'estimated' : telemetry.derived?.copQuality ?? null;

  const mode = telemetry.status?.mode ?? null;
  const defrost = typeof telemetry.status?.defrost === 'boolean' ? (telemetry.status.defrost ? 1 : 0) : null;
  const online = typeof telemetry.status?.online === 'boolean' ? (telemetry.status.online ? 1 : 0) : 1;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO telemetry (device_id, ts, metrics_json, deltaT, thermalKW, cop, cop_quality, status_json, faults_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      telemetry.deviceId,
      telemetry.ts,
      metricsJson,
      deltaT,
      thermalKW,
      cop,
      copQuality,
      statusJson,
      faultsJson,
    ),
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
         updated_at = excluded.updated_at`,
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
      faultsJson,
    ),
    env.DB.prepare(`UPDATE devices SET online = 1, last_seen_at = ? WHERE device_id = ?`).bind(
      telemetry.ts,
      telemetry.deviceId,
    ),
  ]);

  const id = env.DeviceState.idFromName(telemetry.deviceId);
  const stub = env.DeviceState.get(id);
  ctx.waitUntil(
    stub.fetch('https://do/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetry, receivedAt }),
    }),
  );
}

async function handleHeartbeat(env: Env, ctx: ExecutionContext, context: HeartbeatContext): Promise<void> {
  const { deviceId, ts, rssi, receivedAt } = context;

  await env.DB.batch([
    env.DB.prepare(`UPDATE devices SET online = 1, last_seen_at = ? WHERE device_id = ?`).bind(ts, deviceId),
    env.DB.prepare(
      `UPDATE latest_state SET online = 1, updated_at = datetime('now') WHERE device_id = ?`,
    ).bind(deviceId),
  ]);

  const id = env.DeviceState.idFromName(deviceId);
  const stub = env.DeviceState.get(id);
  ctx.waitUntil(
    stub.fetch('https://do/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, ts, rssi, receivedAt }),
    }),
  );
}
