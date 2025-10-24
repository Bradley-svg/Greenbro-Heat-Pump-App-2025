import type { Env } from '../types/env';
import { getNum } from './settings';

type Kind = 'delta_t' | 'cop' | 'current';

function pctInside(values: number[], p25: number, p75: number) {
  if (!values.length) return 0;
  let k = 0;
  for (const v of values) if (v >= p25 && v <= p75) k++;
  return k / values.length;
}
function median(xs: number[]) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i]! : (s[i - 1]! + s[i]!) / 2;
}

export async function evaluateBaselineDeviation(env: Env, device_id: string, kind: Kind, now = Date.now()) {
  const base = await env.DB.prepare(
    `SELECT sample_json FROM device_baselines
    WHERE device_id=? AND kind=?
    ORDER BY is_golden DESC, created_at DESC LIMIT 1`,
  )
    .bind(device_id, kind)
    .first<{ sample_json: string }>();
  if (!base) return null;

  const { p25, p75, median: bMed } = JSON.parse(base.sample_json ?? '{}');
  if (typeof p25 !== 'number' || typeof p75 !== 'number') return null;

  const id = env.DeviceState.idFromName(device_id);
  const stub = env.DeviceState.get(id);
  const bufRes = await stub.fetch(`https://do/window?kind=${kind}`);
  if (!bufRes.ok) return null;
  const buf = (await bufRes.json()) as Array<{ t: number; v: number | null | undefined }>;
  const vals = buf.map((b) => b.v).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (!vals.length) return null;

  const coverage = pctInside(vals, p25, p75);
  const med = median(vals);
  const drift = Number.isFinite(med) && Number.isFinite(bMed) ? med - bMed : null;

  // Threshold keys vary per kind
  const suffix = kind === 'delta_t' ? '' : `_${kind}`;
  const covWarn = await getNum(env.DB, `baseline_cov_warn${suffix}`, kind === 'cop' ? 0.6 : 0.6);
  const covCrit = await getNum(env.DB, `baseline_cov_crit${suffix}`, kind === 'cop' ? 0.4 : 0.4);
  const dWarn = await getNum(
    env.DB,
    `baseline_drift_warn${suffix}`,
    kind === 'cop' ? 0.15 : kind === 'current' ? 1.0 : 0.8,
  );
  const dCrit = await getNum(
    env.DB,
    `baseline_drift_crit${suffix}`,
    kind === 'cop' ? 0.3 : kind === 'current' ? 2.0 : 1.5,
  );
  const dwellS = await getNum(env.DB, 'baseline_dwell_s', 600);

  let level: 'ok' | 'warn' | 'crit' = 'ok';
  if (coverage <= covCrit || (drift != null && Math.abs(drift) >= dCrit)) level = 'crit';
  else if (coverage <= covWarn || (drift != null && Math.abs(drift) >= dWarn)) level = 'warn';

  return { level, coverage, drift, now, dwellS } as const;
}

export type BaselineKind = Kind;
