import type { D1Database } from '@cloudflare/workers-types';
import { median } from './stats';

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

export async function getWindowSample(DB: D1Database, device_id: string, seconds = 90) {
  const since = `-${seconds} seconds`;
  const rows = await DB.prepare(
    `
      SELECT ts, metrics_json, delta_t, cop
      FROM telemetry
      WHERE device_id=? AND ts >= datetime('now', ?)
      ORDER BY ts ASC
      LIMIT 300
    `,
  )
    .bind(device_id, since)
    .all<{
      ts: string;
      metrics_json: string | null;
      delta_t: number | null;
      cop: number | null;
    }>();

  const res = rows.results ?? [];
  const tStart = res[0]?.ts ?? new Date(Date.now() - seconds * 1000).toISOString();
  const tEnd = res.at(-1)?.ts ?? new Date().toISOString();

  const outlets: number[] = [];
  const returns: number[] = [];
  const flows: number[] = [];
  const deltas: number[] = [];
  const cops: number[] = [];

  for (const r of res) {
    let m: Record<string, unknown> = {};
    if (r.metrics_json) {
      try {
        m = JSON.parse(r.metrics_json) as Record<string, unknown>;
      } catch (error) {
        console.warn('Failed to parse metrics_json', error);
      }
    }
    const outlet = typeof m.outlet_temp_c === 'number' ? m.outlet_temp_c : undefined;
    const ret = typeof m.return_temp_c === 'number' ? m.return_temp_c : undefined;
    const flow = typeof m.flow_lpm === 'number' ? m.flow_lpm : undefined;
    if (typeof outlet === 'number') outlets.push(outlet);
    if (typeof ret === 'number') returns.push(ret);
    if (typeof flow === 'number') flows.push(flow);
    if (typeof r.delta_t === 'number') deltas.push(r.delta_t);
    if (typeof r.cop === 'number') cops.push(r.cop);
  }

  const deltaFromTemps = outlets.length && returns.length
    ? median(outlets.map((o, i) => (typeof returns[i] === 'number' ? o - returns[i] : Number.NaN)))
    : null;

  return {
    count: res.length,
    window_s: seconds,
    t_start: tStart,
    t_end: tEnd,
    outlet_c_med: median(outlets),
    return_c_med: median(returns),
    flow_lpm_med: median(flows),
    delta_t_med: median(deltas.length ? deltas : deltaFromTemps != null ? [deltaFromTemps] : []),
    cop_med: median(cops),
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
