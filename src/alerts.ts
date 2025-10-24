import type { Env } from './types/env';
import type { TelemetryPayload } from './types';
import { evaluateBaselineDeviation } from './lib/baseline-eval';

export type Severity = 'minor' | 'major' | 'critical';

export type RuleName =
  | 'overheat'
  | 'low_flow_under_load'
  | 'low_cop'
  | 'short_cycling'
  | 'no_heartbeat_warn'
  | 'no_heartbeat_crit';

export type RuleConfig = {
  dwellSec: number;
  cooldownSec: number;
  suppressWhenOffline?: boolean;
};

export const RULES: Record<RuleName, RuleConfig> = {
  overheat: { dwellSec: 120, cooldownSec: 300 },
  low_flow_under_load: { dwellSec: 90, cooldownSec: 300, suppressWhenOffline: true },
  low_cop: { dwellSec: 600, cooldownSec: 900, suppressWhenOffline: true },
  short_cycling: { dwellSec: 0, cooldownSec: 900, suppressWhenOffline: false },
  no_heartbeat_warn: { dwellSec: 0, cooldownSec: 0 },
  no_heartbeat_crit: { dwellSec: 0, cooldownSec: 0 },
};

const isRuleName = (value: string): value is RuleName => value in RULES;

export type Derived = {
  deltaT: number | null;
  thermalKW: number | null;
  cop: number | null;
  copQuality: 'measured' | 'estimated' | null;
};

const THRESH = {
  overheatC: 60,
  minFlowLps: 0.05,
  lowCop: 2.0,
  minPowerKWForLowCop: 0.8,
  shortCycleWindowSec: 600,
  shortCycleToggles: 3,
  heartbeatWarnSec: 300,
  heartbeatCritSec: 1200,
};

export async function evaluateTelemetryAlerts(env: Env, t: TelemetryPayload, d: Derived) {
  const deviceId = t.deviceId;
  const ts = t.ts;
  const online = t.status?.online ?? true;
  const compRunning = (t.metrics.compCurrentA ?? 0) > 0.5 || (t.metrics.powerKW ?? 0) > 0.3;

  for (const [ruleName, cfg] of Object.entries(RULES) as Array<[RuleName, RuleConfig]>) {
    if (!cfg.suppressWhenOffline) continue;
    await setSuppress(env, deviceId, ruleName, online ? false : true);
  }

  if (t.metrics.supplyC != null && t.metrics.supplyC >= THRESH.overheatC) {
    await maybeOpen(env, deviceId, ts, 'overheat', 'critical', { supplyC: t.metrics.supplyC });
  } else {
    await maybeClose(env, deviceId, ts, 'overheat');
  }

  if (compRunning && t.metrics.flowLps != null && t.metrics.flowLps < THRESH.minFlowLps && online) {
    await maybeOpen(env, deviceId, ts, 'low_flow_under_load', 'major', { flowLps: t.metrics.flowLps });
  } else {
    await maybeClose(env, deviceId, ts, 'low_flow_under_load');
  }

  if (d.cop != null && (t.metrics.powerKW ?? 0) >= THRESH.minPowerKWForLowCop && d.cop < THRESH.lowCop) {
    await maybeOpen(env, deviceId, ts, 'low_cop', 'minor', { cop: d.cop });
  } else {
    await maybeClose(env, deviceId, ts, 'low_cop');
  }

  await trackShortCycling(env, deviceId, ts, compRunning);
}

export async function evaluateBaselineAlerts(env: Env, deviceId: string, now = Date.now()) {
  const kinds: Array<{ kind: 'delta_t' | 'cop' | 'current'; units: string }> = [
    { kind: 'delta_t', units: '°C' },
    { kind: 'cop', units: '' },
    { kind: 'current', units: 'A' },
  ];

  for (const { kind, units } of kinds) {
    const result = await evaluateBaselineDeviation(env, deviceId, kind, now).catch((error) => {
      console.error('baseline deviation eval error', error);
      return null;
    });
    if (!result) continue;

    const type = 'baseline_deviation';
    const ruleKey = `${type}:${kind}`;
    const tsISO = new Date(result.now).toISOString();
    const meta = { kind, coverage: result.coverage, drift: result.drift, units } as const;

    if (await isMaintenanceActive(env, deviceId, tsISO)) {
      await resetDwell(env, deviceId, ruleKey);
      continue;
    }

    const severity: Severity | null =
      result.level === 'crit' ? 'critical' : result.level === 'warn' ? 'major' : null;

    if (!severity) {
      await closeBaselineAlert(env, deviceId, type, ruleKey, tsISO, result.dwellS, meta);
      continue;
    }

    await openOrUpdateBaselineAlert(env, deviceId, type, ruleKey, tsISO, severity, result.dwellS, meta);
  }
}

export async function openAlertIfNeeded(
  env: Env,
  deviceId: string,
  type: string,
  severity: Severity,
  tsISO: string,
  meta: Record<string, unknown>,
) {
  if (await isMaintenanceActive(env, deviceId, tsISO)) {
    if (isRuleName(type)) {
      await resetDwell(env, deviceId, type);
    }
    return;
  }

  const open = await env.DB.prepare(
    "SELECT alert_id FROM alerts WHERE device_id=? AND type=? AND state IN ('open','ack') ORDER BY opened_at DESC LIMIT 1",
  )
    .bind(deviceId, type)
    .first<{ alert_id: string }>();

  if (open) return;

  const alertId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO alerts (alert_id, device_id, type, severity, state, opened_at, meta_json)
     VALUES (?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(alertId, deviceId, type, severity, tsISO, JSON.stringify(meta))
    .run();
}

async function trackShortCycling(env: Env, deviceId: string, tsISO: string, compRunning: boolean) {
  const rule: RuleName = 'short_cycling';
  const now = Date.parse(tsISO);
  const windowMs = THRESH.shortCycleWindowSec * 1000;

  await env.DB.exec('CREATE TABLE IF NOT EXISTS short_cycle_buf (device_id TEXT PRIMARY KEY, data TEXT)');
  const row = await env.DB.prepare('SELECT data FROM short_cycle_buf WHERE device_id=?')
    .bind(deviceId)
    .first<{ data: string }>();
  let data: { last?: boolean; toggles: number[] } = row?.data ? JSON.parse(row.data) : { toggles: [] };

  if (data.last === undefined) data.last = compRunning;
  if (data.last !== compRunning) {
    data.last = compRunning;
    data.toggles.push(now);
  }
  data.toggles = data.toggles.filter((ts) => now - ts <= windowMs);

  await env.DB.prepare(
    'INSERT INTO short_cycle_buf (device_id, data) VALUES(?, ?) ON CONFLICT(device_id) DO UPDATE SET data=excluded.data',
  )
    .bind(deviceId, JSON.stringify(data))
    .run();

  if (data.toggles.length >= THRESH.shortCycleToggles) {
    await maybeOpen(env, deviceId, tsISO, rule, 'major', { toggles: data.toggles.length });
  }
}

async function closeBaselineAlert(
  env: Env,
  deviceId: string,
  type: string,
  ruleKey: string,
  tsISO: string,
  dwellS: number,
  meta: Record<string, unknown>,
) {
  const kind = typeof meta.kind === 'string' ? meta.kind : 'delta_t';
  const open = await env.DB.prepare(
    `SELECT alert_id FROM alerts
     WHERE device_id=? AND type=? AND state IN ('open','ack')
       AND COALESCE(json_extract(meta_json,'$.kind'),'delta_t')=?
     ORDER BY opened_at DESC LIMIT 1`,
  )
    .bind(deviceId, type, kind)
    .first<{ alert_id: string }>();
  const st = await loadState(env, deviceId, ruleKey);

  if (!open) {
    if (st.dwell_start_ts || st.last_trigger_ts) {
      await saveState(env, deviceId, ruleKey, {
        ...st,
        dwell_start_ts: null,
        last_trigger_ts: null,
      });
    }
    return;
  }

  await env.DB.prepare("UPDATE alerts SET state='closed', closed_at=?, meta_json=? WHERE alert_id=?")
    .bind(tsISO, JSON.stringify(meta), open.alert_id)
    .run();

  const cooldownUntil = new Date(Date.parse(tsISO) + Math.max(dwellS, 0) * 1000).toISOString();
  await saveState(env, deviceId, ruleKey, {
    ...st,
    dwell_start_ts: null,
    last_trigger_ts: null,
    cooldown_until_ts: cooldownUntil,
  });
}

async function openOrUpdateBaselineAlert(
  env: Env,
  deviceId: string,
  type: string,
  ruleKey: string,
  tsISO: string,
  severity: Severity,
  dwellS: number,
  meta: { kind: string; coverage: number; drift: number | null; units: string },
) {
  const now = Date.parse(tsISO);
  const st = await loadState(env, deviceId, ruleKey);

  if (st.suppress) return;

  if (st.cooldown_until_ts && Date.parse(st.cooldown_until_ts) > now) {
    await saveState(env, deviceId, ruleKey, { ...st, last_trigger_ts: tsISO });
    return;
  }

  let dwellStart = st.dwell_start_ts ? Date.parse(st.dwell_start_ts) : null;
  if (!st.dwell_start_ts) {
    dwellStart = now;
    await saveState(env, deviceId, ruleKey, {
      ...st,
      dwell_start_ts: tsISO,
      last_trigger_ts: tsISO,
    });
  } else {
    await saveState(env, deviceId, ruleKey, { ...st, last_trigger_ts: tsISO });
  }

  const dwellMet = now - (dwellStart ?? now) >= dwellS * 1000;
  if (!dwellMet) return;

  const kind = meta.kind ?? 'delta_t';
  const open = await env.DB.prepare(
    `SELECT alert_id, severity FROM alerts
     WHERE device_id=? AND type=? AND state IN ('open','ack')
       AND COALESCE(json_extract(meta_json,'$.kind'),'delta_t')=?
     ORDER BY opened_at DESC LIMIT 1`,
  )
    .bind(deviceId, type, kind)
    .first<{ alert_id: string; severity: string | null }>();

  const metaJson = JSON.stringify(meta);
  if (!open) {
    const alertId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO alerts (alert_id, device_id, type, severity, state, opened_at, meta_json)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`,
    )
      .bind(alertId, deviceId, type, severity, tsISO, metaJson)
      .run();
    return;
  }

  await env.DB.prepare('UPDATE alerts SET severity=?, meta_json=? WHERE alert_id=?')
    .bind(severity, metaJson, open.alert_id)
    .run();
}

export async function evaluateHeartbeatAlerts(env: Env, nowISO: string) {
  const now = Date.parse(nowISO);
  const warnMs = THRESH.heartbeatWarnSec * 1000;
  const critMs = THRESH.heartbeatCritSec * 1000;

  const devices = await env.DB.prepare('SELECT device_id, last_seen_at FROM devices').all<{
    device_id: string;
    last_seen_at: string;
  }>();
  for (const row of devices.results ?? []) {
    const last = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    const gap = now - last;
    const online = gap <= warnMs;

    for (const [ruleName, cfg] of Object.entries(RULES) as Array<[RuleName, RuleConfig]>) {
      if (!cfg.suppressWhenOffline) continue;
      await setSuppress(env, row.device_id, ruleName, online ? false : true);
    }

    if (gap > critMs) {
      await maybeOpen(env, row.device_id, nowISO, 'no_heartbeat_crit', 'critical', {
        minutes: Math.round(gap / 60000),
      });
      await maybeClose(env, row.device_id, nowISO, 'no_heartbeat_warn');
    } else if (gap > warnMs) {
      await maybeOpen(env, row.device_id, nowISO, 'no_heartbeat_warn', 'major', {
        minutes: Math.round(gap / 60000),
      });
      await maybeClose(env, row.device_id, nowISO, 'no_heartbeat_crit');
    } else {
      await maybeClose(env, row.device_id, nowISO, 'no_heartbeat_warn');
      await maybeClose(env, row.device_id, nowISO, 'no_heartbeat_crit');
    }

    await env.DB.prepare('UPDATE devices SET online=? WHERE device_id=?')
      .bind(online ? 1 : 0, row.device_id)
      .run();
  }
}

async function maybeOpen(
  env: Env,
  deviceId: string,
  tsISO: string,
  rule: RuleName,
  severity: Severity,
  meta: Record<string, unknown>,
) {
  const cfg = RULES[rule];
  const now = Date.parse(tsISO);

  if (await isMaintenanceActive(env, deviceId, tsISO)) {
    await resetDwell(env, deviceId, rule);
    return;
  }

  const st = await loadState(env, deviceId, rule);

  if (st.cooldown_until_ts && Date.parse(st.cooldown_until_ts) > now) {
    return;
  }

  if (st.suppress) return;

  const dwellStart = st.dwell_start_ts ? Date.parse(st.dwell_start_ts) : now;
  const dwellMet = (now - dwellStart) / 1000 >= cfg.dwellSec;

  if (!st.dwell_start_ts) {
    await saveState(env, deviceId, rule, { ...st, dwell_start_ts: tsISO, last_trigger_ts: tsISO });
  } else {
    await saveState(env, deviceId, rule, { ...st, last_trigger_ts: tsISO });
  }

  if (!dwellMet) return;

  const open = await env.DB.prepare(
    "SELECT alert_id FROM alerts WHERE device_id=? AND type=? AND state IN ('open','ack') ORDER BY opened_at DESC LIMIT 1",
  )
    .bind(deviceId, rule)
    .first<{ alert_id: string }>();

  if (open) return;

  const alertId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO alerts (alert_id, device_id, type, severity, state, opened_at, meta_json)
     VALUES (?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(alertId, deviceId, rule, severity, tsISO, JSON.stringify(meta))
    .run();
}

async function maybeClose(env: Env, deviceId: string, tsISO: string, rule: RuleName) {
  const open = await env.DB.prepare(
    "SELECT alert_id, opened_at FROM alerts WHERE device_id=? AND type=? AND state IN ('open','ack') ORDER BY opened_at DESC LIMIT 1",
  )
    .bind(deviceId, rule)
    .first<{ alert_id: string; opened_at: string }>();

  if (!open) {
    const st = await loadState(env, deviceId, rule);
    if (st.dwell_start_ts || st.last_trigger_ts) {
      await saveState(env, deviceId, rule, { ...st, dwell_start_ts: null, last_trigger_ts: null });
    }
    return;
  }

  await env.DB.prepare("UPDATE alerts SET state='closed', closed_at=? WHERE alert_id=?")
    .bind(tsISO, open.alert_id)
    .run();

  const cooldownUntil = new Date(Date.parse(tsISO) + RULES[rule].cooldownSec * 1000).toISOString();
  const st = await loadState(env, deviceId, rule);
  await saveState(env, deviceId, rule, {
    ...st,
    dwell_start_ts: null,
    last_trigger_ts: null,
    cooldown_until_ts: cooldownUntil,
  });
}

async function loadState(env: Env, deviceId: string, rule: string) {
  const row = await env.DB.prepare(
    'SELECT last_trigger_ts, dwell_start_ts, cooldown_until_ts, suppress FROM alert_state WHERE device_id=? AND rule=?',
  )
    .bind(deviceId, rule)
    .first<{
      last_trigger_ts: string | null;
      dwell_start_ts: string | null;
      cooldown_until_ts: string | null;
      suppress: number;
    }>();
  return (
    row ?? {
      last_trigger_ts: null,
      dwell_start_ts: null,
      cooldown_until_ts: null,
      suppress: 0,
    }
  );
}

async function resetDwell(env: Env, deviceId: string, rule: string) {
  const st = await loadState(env, deviceId, rule);
  if (st.dwell_start_ts || st.last_trigger_ts) {
    await saveState(env, deviceId, rule, {
      ...st,
      dwell_start_ts: null,
      last_trigger_ts: null,
    });
  }
}

async function saveState(
  env: Env,
  deviceId: string,
  rule: string,
  st: {
    last_trigger_ts: string | null;
    dwell_start_ts: string | null;
    cooldown_until_ts: string | null;
    suppress: number;
  },
) {
  await env.DB.prepare(
    `INSERT INTO alert_state (device_id, rule, last_trigger_ts, dwell_start_ts, cooldown_until_ts, suppress)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id, rule) DO UPDATE SET
       last_trigger_ts=excluded.last_trigger_ts,
       dwell_start_ts=excluded.dwell_start_ts,
       cooldown_until_ts=excluded.cooldown_until_ts,
       suppress=excluded.suppress`,
  )
    .bind(deviceId, rule, st.last_trigger_ts, st.dwell_start_ts, st.cooldown_until_ts, st.suppress)
    .run();
}

async function setSuppress(env: Env, deviceId: string, rule: string, shouldSuppress: boolean) {
  const st = await loadState(env, deviceId, rule);
  const suppress = shouldSuppress ? 1 : 0;
  if (st.suppress === suppress) {
    return;
  }
  await saveState(env, deviceId, rule, {
    ...st,
    suppress,
    dwell_start_ts: shouldSuppress ? null : st.dwell_start_ts,
    last_trigger_ts: shouldSuppress ? null : st.last_trigger_ts,
  });
}

async function isMaintenanceActive(env: Env, deviceId: string, tsISO: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT site_id FROM devices WHERE device_id=?')
    .bind(deviceId)
    .first<{ site_id: string | null }>()
    .catch(() => null);
  const siteId = row?.site_id ?? null;

  const active = await env.DB.prepare(
    `SELECT 1 FROM maintenance_windows
     WHERE start_ts <= ? AND (end_ts IS NULL OR end_ts >= ?)
       AND (
         (device_id IS NOT NULL AND device_id = ?)
         OR (device_id IS NULL AND site_id IS NOT NULL AND site_id = ?)
         OR (device_id IS NULL AND site_id IS NULL)
       )
     LIMIT 1`,
  )
    .bind(tsISO, tsISO, deviceId, siteId)
    .first<{ 1: number }>()
    .catch(() => null);

  return Boolean(active);
}
