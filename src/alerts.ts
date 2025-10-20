import type { Env, TelemetryPayload } from './types';

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

async function loadState(env: Env, deviceId: string, rule: RuleName) {
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

async function saveState(
  env: Env,
  deviceId: string,
  rule: RuleName,
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

async function setSuppress(env: Env, deviceId: string, rule: RuleName, shouldSuppress: boolean) {
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
