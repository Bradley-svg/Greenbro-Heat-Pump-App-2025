import type { Env } from '../types/env';
import { getNum } from './settings';

function pctInside(values: number[], p25: number, p75: number) {
  if (!values.length) return 0;
  let inr = 0;
  for (const v of values) {
    if (v >= p25 && v <= p75) inr += 1;
  }
  return inr / values.length;
}

function median(xs: number[]) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

export type BaselineDeviationResult = {
  level: 'ok' | 'warn' | 'crit';
  coverage: number;
  drift: number | null;
  now: number;
  dwellS: number;
};

export async function evaluateBaselineDeviation(
  env: Env,
  deviceId: string,
  now = Date.now(),
): Promise<BaselineDeviationResult | null> {
  const base = await env.DB.prepare(
    `SELECT sample_json FROM device_baselines
     WHERE device_id=? AND kind='delta_t'
     ORDER BY is_golden DESC, created_at DESC LIMIT 1`,
  )
    .bind(deviceId)
    .first<{ sample_json: string }>();
  if (!base) return null;

  const parsed = base.sample_json ? JSON.parse(base.sample_json) : {};
  const { p25, p75, median: bMed } = parsed as { p25?: number; p75?: number; median?: number };
  if (typeof p25 !== 'number' || typeof p75 !== 'number') return null;

  const id = env.DeviceState.idFromName(deviceId);
  const stub = env.DeviceState.get(id);
  const bufRes = await stub.fetch('https://do/window');
  if (!bufRes.ok) return null;
  const buf = (await bufRes.json()) as Array<{ t: number; dt?: number }>;
  const vals = buf
    .map((b) => (typeof b.dt === 'number' && Number.isFinite(b.dt) ? b.dt : null))
    .filter((n): n is number => n != null);
  if (!vals.length) return null;

  const coverage = pctInside(vals, p25, p75);
  const med = median(vals);
  const drift = Number.isFinite(med) && typeof bMed === 'number' && Number.isFinite(bMed) ? med - bMed : null;

  const covWarn = await getNum(env.DB, 'baseline_cov_warn', 0.6);
  const covCrit = await getNum(env.DB, 'baseline_cov_crit', 0.4);
  const dWarn = await getNum(env.DB, 'baseline_drift_warn', 0.8);
  const dCrit = await getNum(env.DB, 'baseline_drift_crit', 1.5);
  const dwellS = await getNum(env.DB, 'baseline_dwell_s', 600);

  let level: 'ok' | 'warn' | 'crit' = 'ok';
  if (coverage <= covCrit || (drift != null && Math.abs(drift) >= dCrit)) {
    level = 'crit';
  } else if (coverage <= covWarn || (drift != null && Math.abs(drift) >= dWarn)) {
    level = 'warn';
  }

  return { level, coverage, drift, now, dwellS };
}
