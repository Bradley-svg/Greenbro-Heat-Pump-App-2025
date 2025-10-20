import type { Env, IngestMessage, TelemetryPayload } from './types';

export async function handleQueueBatch(
  batch: MessageBatch<IngestMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const receivedAt = new Date().toISOString();

      if (message.body.kind === 'telemetry') {
        const telemetry = sanitizeTelemetry(message.body.body);
        const derived = computeDerived(telemetry);

        await persistTelemetry(env, telemetry, derived);
        await upsertLatest(env, telemetry, derived);
        await dispatchTelemetry(env, ctx, telemetry, derived, receivedAt);
      } else {
        const heartbeat = {
          deviceId: message.body.body.deviceId,
          ts: message.body.body.ts,
          rssi: message.body.body.rssi,
        };

        await handleHeartbeat(env, ctx, heartbeat, receivedAt);
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
  };
}

function computeDerived(telemetry: TelemetryPayload) {
  const supply = telemetry.metrics.supplyC ?? null;
  const ret = telemetry.metrics.returnC ?? null;
  const flow = telemetry.metrics.flowLps ?? null;
  const power = telemetry.metrics.powerKW ?? null;

  const deltaT = supply != null && ret != null ? round1(supply - ret) : null;
  const rho = 0.997;
  const cp = 4.186;
  const thermalKW = flow != null && deltaT != null ? round2((rho * cp * flow * deltaT) / 1_000) : null;

  let cop: number | null = null;
  let copQuality: 'measured' | 'estimated' | null = null;

  if (thermalKW != null && power != null && power > 0.05) {
    cop = round2(thermalKW / power);
    copQuality = 'measured';
  } else if (thermalKW != null) {
    cop = null;
    copQuality = 'estimated';
  }

  return { deltaT, thermalKW, cop, copQuality };
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
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

  ctx.waitUntil(
    stub.fetch('https://do/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetry, derived, receivedAt }),
    }),
  );
}

async function handleHeartbeat(
  env: Env,
  ctx: ExecutionContext,
  heartbeat: { deviceId: string; ts: string; rssi?: number },
  receivedAt: string,
) {
  await env.DB.batch([
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
