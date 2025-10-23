import type { D1Database } from '../types/env';

export async function getLatestTelemetry(DB: D1Database, deviceId: string) {
  const latest = await DB.prepare(
    'SELECT ts, metrics_json, delta_t, cop FROM latest_state WHERE device_id=?',
  )
    .bind(deviceId)
    .first<{
      ts: string;
      metrics_json: string | null;
      delta_t: number | null;
      cop: number | null;
    }>();

  if (latest) {
    const metrics = safeParseMetrics(latest.metrics_json);
    return {
      ts: latest.ts,
      outlet: metrics.outlet_temp_c,
      ret: metrics.return_temp_c,
      flow_lpm: metrics.flow_lpm,
      cop: latest.cop,
      delta_t: latest.delta_t,
    } as const;
  }

  const hist = await DB.prepare(
    'SELECT ts, metrics_json, delta_t, cop FROM telemetry WHERE device_id=? ORDER BY ts DESC LIMIT 1',
  )
    .bind(deviceId)
    .first<{
      ts: string;
      metrics_json: string | null;
      delta_t: number | null;
      cop: number | null;
    }>();

  if (!hist) {
    return null;
  }

  const metrics = safeParseMetrics(hist.metrics_json);
  return {
    ts: hist.ts,
    outlet: metrics.outlet_temp_c,
    ret: metrics.return_temp_c,
    flow_lpm: metrics.flow_lpm,
    cop: hist.cop,
    delta_t: hist.delta_t,
  } as const;
}

export function computeDeltaT(outlet?: number, ret?: number): number | null {
  if (typeof outlet !== 'number' || Number.isNaN(outlet)) {
    return null;
  }
  if (typeof ret !== 'number' || Number.isNaN(ret)) {
    return null;
  }
  return outlet - ret;
}

function safeParseMetrics(value: string | null | undefined): Record<string, number | null | undefined> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, number | null | undefined>;
    }
  } catch (error) {
    console.warn('Failed to parse metrics_json', error);
  }
  return {};
}
