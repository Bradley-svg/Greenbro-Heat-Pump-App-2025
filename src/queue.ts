import type { Env, ExecutionContext, MessageBatch } from './types/env';
import type { IngestMessage, TelemetryPayload } from './types';
import { computeDerived, computeDerivedFromTelemetry } from './lib/math';

export async function handleQueueBatch(
  batch: MessageBatch<IngestMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    const started = Date.now();
    try {
      const receivedAt = new Date().toISOString();

      if (message.body.type === 'telemetry') {
        const telemetry = sanitizeTelemetry(message.body.body);
        const derived = computeDerivedFromTelemetry(telemetry);

        await persistTelemetry(env, telemetry, derived);
        await upsertLatest(env, telemetry, derived);
        await dispatchTelemetry(env, ctx, telemetry, derived, receivedAt);
        await logQueueMetric(env, '/queue/ingest', 200, Date.now() - started, telemetry.deviceId);
      } else if (message.body.type === 'heartbeat') {
        const heartbeat = {
          deviceId: message.body.body.deviceId,
          ts: message.body.body.ts,
          rssi: message.body.body.rssi,
        };

        await handleHeartbeat(env, ctx, heartbeat, receivedAt);
        await logQueueMetric(env, '/queue/ingest', 200, Date.now() - started, heartbeat.deviceId);
      } else {
        await logQueueMetric(env, '/queue/ingest', 422, Date.now() - started, null);
      }

      message.ack();
    } catch (error) {
      console.error('Failed to process queue message', error);
      const body = message.body;
      const deviceId = body?.type === 'telemetry' || body?.type === 'heartbeat' ? body.body.deviceId : null;
      await logQueueMetric(env, '/queue/ingest', 500, Date.now() - started, deviceId ?? null);
      message.retry();
    }
  }
}

function sanitizeTelemetry(input: TelemetryPayload): TelemetryPayload {
  const metrics = { ...input.metrics };
  const coerceNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  const sanitizeFlagGroup = (group: unknown): Record<string, boolean> | undefined => {
    if (!group || typeof group !== 'object') {
      return undefined;
    }
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(group as Record<string, unknown>)) {
      if (typeof value === 'boolean') {
        result[key] = value;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  };

  const sanitizeFlags = (flags: unknown): Record<string, Record<string, boolean>> | undefined => {
    if (!flags || typeof flags !== 'object') {
      return undefined;
    }
    const result: Record<string, Record<string, boolean>> = {};
    for (const [groupKey, groupValue] of Object.entries(flags as Record<string, unknown>)) {
      const sanitizedGroup = sanitizeFlagGroup(groupValue);
      if (sanitizedGroup) {
        result[groupKey] = sanitizedGroup;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  };

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
    status: input.status
      ? {
          mode: typeof input.status.mode === 'string' ? input.status.mode : undefined,
          defrost: typeof input.status.defrost === 'boolean' ? input.status.defrost : undefined,
          online: typeof input.status.online === 'boolean' ? input.status.online : undefined,
          flags: sanitizeFlags(input.status.flags),
        }
      : undefined,
    faults: Array.isArray(input.faults)
      ? input.faults
          .map((fault) =>
            fault && typeof fault.code === 'string' && typeof fault.active === 'boolean'
              ? {
                  code: fault.code,
                  active: fault.active,
                  ...(typeof fault.description === 'string' && fault.description.length > 0
                    ? { description: fault.description }
                    : {}),
                }
              : undefined,
          )
          .filter(
            (fault): fault is { code: string; active: boolean; description?: string } =>
              fault !== undefined,
          )
      : undefined,
  };
}

async function persistTelemetry(
  env: Env,
  telemetry: TelemetryPayload,
  derived: ReturnType<typeof computeDerived>,
) {
  const metricsJson = JSON.stringify(telemetry.metrics);
  const statusJson = telemetry.status ? JSON.stringify(telemetry.status) : null;
  const faultsJson = telemetry.faults ? JSON.stringify(telemetry.faults) : null;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO telemetry
     (device_id, ts, metrics_json, deltaT, thermalKW, cop, cop_quality, status_json, faults_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      telemetry.deviceId,
      telemetry.ts,
      metricsJson,
      derived.deltaT,
      derived.thermalKW,
      derived.cop,
      derived.copQuality,
      statusJson,
      faultsJson,
    )
    .run();

  await env.DB.prepare(
    'UPDATE devices SET online = 1, last_seen_at = ? WHERE device_id = ?',
  )
    .bind(telemetry.ts, telemetry.deviceId)
    .run();
}

async function upsertLatest(
  env: Env,
  telemetry: TelemetryPayload,
  derived: ReturnType<typeof computeDerived>,
) {
  const faultsJson = telemetry.faults ? JSON.stringify(telemetry.faults) : null;

  await env.DB.prepare(
    `INSERT INTO latest_state
     (device_id, ts, supplyC, returnC, tankC, ambientC, flowLps, compCurrentA, eevSteps, powerKW,
      deltaT, thermalKW, cop, cop_quality, mode, defrost, online, faults_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
      ts = excluded.ts, supplyC = excluded.supplyC, returnC = excluded.returnC, tankC = excluded.tankC,
      ambientC = excluded.ambientC, flowLps = excluded.flowLps, compCurrentA = excluded.compCurrentA,
      eevSteps = excluded.eevSteps, powerKW = excluded.powerKW, deltaT = excluded.deltaT, thermalKW = excluded.thermalKW,
      cop = excluded.cop, cop_quality = excluded.cop_quality, mode = excluded.mode, defrost = excluded.defrost,
      online = excluded.online, faults_json = excluded.faults_json, updated_at = datetime('now')`,
  )
    .bind(
      telemetry.deviceId,
      telemetry.ts,
      telemetry.metrics.supplyC ?? null,
      telemetry.metrics.returnC ?? null,
      telemetry.metrics.tankC ?? null,
      telemetry.metrics.ambientC ?? null,
      telemetry.metrics.flowLps ?? null,
      telemetry.metrics.compCurrentA ?? null,
      telemetry.metrics.eevSteps ?? null,
      telemetry.metrics.powerKW ?? null,
      derived.deltaT,
      derived.thermalKW,
      derived.cop,
      derived.copQuality,
      telemetry.status?.mode ?? null,
      telemetry.status?.defrost ? 1 : 0,
      (telemetry.status?.online ?? true) ? 1 : 0,
      faultsJson,
    )
    .run();
}

async function dispatchTelemetry(
  env: Env,
  ctx: ExecutionContext,
  telemetry: TelemetryPayload,
  derived: ReturnType<typeof computeDerived>,
  receivedAt: string,
) {
  const id = env.DeviceState.idFromName(telemetry.deviceId);
  const stub = env.DeviceState.get(id);

  const appendBody = {
    t: Date.now(),
    delta_t: derived.deltaT,
    cop: derived.cop,
    current: telemetry.metrics.compCurrentA ?? null,
  };

  ctx.waitUntil(
    Promise.all([
      stub.fetch('https://do/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ telemetry, derived, receivedAt }),
      }),
      stub.fetch('https://do/append', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(appendBody),
      }),
    ]).then(() => undefined),
  );
}

async function handleHeartbeat(
  env: Env,
  ctx: ExecutionContext,
  heartbeat: { deviceId: string; ts: string; rssi?: number },
  receivedAt: string,
) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO heartbeat (ts, device_id, rssi) VALUES (?, ?, ?)')
      .bind(heartbeat.ts, heartbeat.deviceId, heartbeat.rssi ?? null),
    env.DB.prepare('UPDATE devices SET online = 1, last_seen_at = ? WHERE device_id = ?').bind(
      heartbeat.ts,
      heartbeat.deviceId,
    ),
    env.DB.prepare(
      "UPDATE latest_state SET online = 1, updated_at = datetime('now') WHERE device_id = ?",
    ).bind(heartbeat.deviceId),
  ]);

  const id = env.DeviceState.idFromName(heartbeat.deviceId);
  const stub = env.DeviceState.get(id);

  ctx.waitUntil(
    stub.fetch('https://do/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...heartbeat, receivedAt }),
    }),
  );
}

async function logQueueMetric(
  env: Env,
  route: string,
  statusCode: number,
  durationMs: number,
  deviceId: string | null,
) {
  try {
    await env.DB.prepare(
      'INSERT INTO ops_metrics (ts, route, status_code, duration_ms, device_id) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(new Date().toISOString(), route, statusCode, durationMs, deviceId)
      .run();
  } catch (error) {
    console.warn('logQueueMetric failed', error);
  }
}
