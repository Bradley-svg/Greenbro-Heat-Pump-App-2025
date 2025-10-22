/** @jsxImportSource hono/jsx */
/** @jsxRuntime automatic */
import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Env, IngestMessage, TelemetryPayload } from './types';
import { verifyAccessJWT, requireRole, type AccessContext } from './rbac';
import { DeviceStateDO } from './do';
import { evaluateTelemetryAlerts, evaluateHeartbeatAlerts, openAlertIfNeeded, type Derived } from './alerts';
import { generateCommissioningPDF, type CommissioningPayload } from './pdf';
import { renderer, OverviewPage, AlertsPage, DevicesPage, AdminSitesPage, OpsPage, type OverviewData } from './ssr';
import { handleQueueBatch as baseQueueHandler } from './queue';

void DeviceStateDO;

function maskId(id: string) {
  if (!id) return id as any;
  return id.length <= 5 ? `•••${id.slice(-2)}` : `${id.slice(0, 3)}…${id.slice(-2)}`;
}

type Ctx = { Bindings: Env; Variables: { auth?: AccessContext } };

const app = new Hono<Ctx>();

app.use('*', cors());

app.use('/api/*', async (c, next) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized (missing Access JWT)', 401);
  }

  try {
    const auth = await verifyAccessJWT(c.env, jwt);
    if (auth.roles.length === 0) {
      return c.text('Forbidden (no role)', 403);
    }
    c.set('auth', auth);
    await next();
  } catch (error) {
    console.warn('Invalid Access JWT', error);
    return c.text('Unauthorized (invalid Access JWT)', 401);
  }
});

app.use('/*', renderer());

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/devices/:id/latest', async (c) => {
  const { DB } = c.env;
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }

  if (auth.roles.includes('client') || auth.roles.includes('contractor')) {
    if (!auth.clientIds || auth.clientIds.length === 0) {
      return c.text('Forbidden', 403);
    }
  }

  const id = c.req.param('id');
  const row = await DB.prepare('SELECT * FROM latest_state WHERE device_id=?').bind(id).first();

  return row ? c.json(row) : c.text('Not found', 404);
});

app.post('/api/devices/:id/write', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const deviceId = c.req.param('id');
  const body = await c.req.json<{ dhwSetC?: number; mode?: string }>();

  const id = c.env.DeviceState.idFromName(deviceId);
  const stub = c.env.DeviceState.get(id);

  const res = await stub.fetch('https://do/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId,
      actor: auth.email ?? auth.sub,
      command: body,
      limits: {
        minC: Number(c.env.WRITE_MIN_C ?? '40'),
        maxC: Number(c.env.WRITE_MAX_C ?? '60'),
      },
    }),
  });

  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get('/api/me/saved-views', async (c) => {
  const auth = c.get('auth');
  const uid = auth?.sub ?? auth?.email;
  if (!uid) {
    return c.json([]);
  }

  const rows = await c.env.DB.prepare(
    'SELECT id, name, route, params_json, created_at FROM saved_views WHERE user_id=? ORDER BY created_at DESC',
  )
    .bind(uid)
    .all<{ id: string; name: string; route: string; params_json: string; created_at: string }>();

  return c.json(rows.results ?? []);
});

app.post('/api/me/saved-views', async (c) => {
  const auth = c.get('auth');
  const uid = auth?.sub ?? auth?.email;
  if (!uid) {
    return c.text('Unauthorized', 401);
  }

  const body = await c.req
    .json<{ name: string; route: string; params: unknown }>()
    .catch(() => null);
  if (!body?.name || !body?.route) {
    return c.text('Bad Request', 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO saved_views (id, user_id, name, route, params_json) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, uid, body.name, body.route, JSON.stringify(body.params ?? {}))
    .run();

  return c.json({ ok: true, id });
});

app.delete('/api/me/saved-views/:id', async (c) => {
  const auth = c.get('auth');
  const uid = auth?.sub ?? auth?.email;
  if (!uid) {
    return c.text('Unauthorized', 401);
  }

  await c.env.DB.prepare('DELETE FROM saved_views WHERE id=? AND user_id=?')
    .bind(c.req.param('id'), uid)
    .run();

  return c.json({ ok: true });
});

// --- Ingest: Telemetry & Heartbeat ---
// Simple shape guard (keep strict & small): 256KB max handled by Cloudflare automatically if set.
type IngestStatus = {
  mode?: string;
  defrost?: boolean;
  online?: boolean;
  [key: string]: unknown;
};

type IngestBody = {
  deviceId: string;
  ts: string; // ISO
  metrics?: Partial<Record<string, number>>;
  status?: IngestStatus;
  heartbeat?: { rssi?: number };
  idempotencyKey?: string; // optional client-provided key
};

app.post('/api/ingest/:profileId', async (c) => {
  const body = await c.req.json<IngestBody>().catch(() => null);
  if (!body?.deviceId || !body?.ts) return c.text('Bad Request', 400);
  const ok = await verifyDeviceKey(c.env.DB, body.deviceId, c.req.header('X-GREENBRO-DEVICE-KEY'));
  if (!ok) return c.text('Forbidden', 403);

  const idemKey =
    body.idempotencyKey ??
    (await (async () => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
      return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
    })());

  if (await isDuplicate(c.env.DB, idemKey)) return c.json({ ok: true, deduped: true });

  const rawMetrics: Partial<Record<string, number>> = body.metrics ?? {};
  const rawStatus: IngestStatus = body.status ?? {};

  const toNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  const telemetryMetrics: TelemetryPayload['metrics'] = {
    tankC: toNumber(rawMetrics.tankC),
    supplyC: toNumber(rawMetrics.supplyC),
    returnC: toNumber(rawMetrics.returnC),
    ambientC: toNumber(rawMetrics.ambientC),
    flowLps: toNumber(rawMetrics.flowLps),
    compCurrentA: toNumber(rawMetrics.compCurrentA),
    eevSteps: toNumber(rawMetrics.eevSteps),
    powerKW: toNumber(rawMetrics.powerKW),
  };

  const telemetryStatus: TelemetryPayload['status'] = {
    mode: typeof rawStatus.mode === 'string' ? rawStatus.mode : undefined,
    defrost: typeof rawStatus.defrost === 'boolean' ? rawStatus.defrost : undefined,
    online: typeof rawStatus.online === 'boolean' ? rawStatus.online : undefined,
  };

  const telemetry: TelemetryPayload = {
    deviceId: body.deviceId,
    ts: body.ts,
    metrics: telemetryMetrics,
    status: telemetryStatus,
  };

  const derived = computeDerived(telemetryMetrics);
  const onlineFlag = telemetryStatus.online === false ? 0 : 1;

  const statusJson = Object.values(telemetryStatus ?? {}).some((v) => v !== undefined)
    ? JSON.stringify(telemetryStatus)
    : null;

  await c.env.DB.prepare(
    `INSERT INTO telemetry (device_id, ts, metrics_json, deltaT, thermalKW, cop, cop_quality, status_json, faults_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      telemetry.deviceId,
      telemetry.ts,
      JSON.stringify(telemetryMetrics),
      derived.deltaT,
      derived.thermalKW,
      derived.cop,
      derived.copQuality,
      statusJson,
    )
    .run();

  await c.env.DB.prepare(
    `INSERT INTO latest_state
      (device_id, ts, supplyC, returnC, tankC, ambientC, flowLps, compCurrentA, eevSteps, powerKW,
       deltaT, thermalKW, cop, cop_quality, mode, defrost, online, faults_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
       updated_at = datetime('now')`,
  )
    .bind(
      body.deviceId,
      body.ts,
      telemetryMetrics.supplyC ?? null,
      telemetryMetrics.returnC ?? null,
      telemetryMetrics.tankC ?? null,
      telemetryMetrics.ambientC ?? null,
      telemetryMetrics.flowLps ?? null,
      telemetryMetrics.compCurrentA ?? null,
      telemetryMetrics.eevSteps ?? null,
      telemetryMetrics.powerKW ?? null,
      telemetryStatus.mode ?? null,
      telemetryStatus.defrost ? 1 : 0,
      onlineFlag,
      derived.deltaT,
      derived.thermalKW,
      derived.cop,
      derived.copQuality,
    )
    .run();

  await c.env.DB.prepare('UPDATE devices SET last_seen_at=?, online=? WHERE device_id=?')
    .bind(body.ts, onlineFlag, body.deviceId)
    .run();

  const latest = await c.env.DB
    .prepare('SELECT deltaT, thermalKW, cop, cop_quality as copQuality FROM latest_state WHERE device_id=?')
    .bind(body.deviceId)
    .first<{ deltaT: number | null; thermalKW: number | null; cop: number | null; copQuality: string | null }>();

  await evaluateTelemetryAlerts(
    c.env,
    telemetry,
    latest ?? { deltaT: null, thermalKW: null, cop: null, copQuality: null },
  );

  const baseline = await c.env.DB.prepare(
    'SELECT dt_mean, dt_std, cop_mean, cop_std FROM baselines_hourly WHERE device_id=? AND how=?',
  )
    .bind(body.deviceId, hourOfWeek(body.ts))
    .first<{
      dt_mean: number | null;
      dt_std: number | null;
      cop_mean: number | null;
      cop_std: number | null;
    }>();

  if (baseline) {
    if (derived.deltaT != null && z(derived.deltaT, baseline.dt_mean, baseline.dt_std) < -2.5) {
      await openAlertIfNeeded(c.env.DB, body.deviceId, 'delta_t_anomaly', 'minor', body.ts, {
        deltaT: derived.deltaT,
      });
    }
    if (derived.cop != null && z(derived.cop, baseline.cop_mean, baseline.cop_std) < -2.5) {
      await openAlertIfNeeded(c.env.DB, body.deviceId, 'low_cop_anomaly', 'major', body.ts, {
        cop: derived.cop,
      });
    }
  }

  return c.json({ ok: true });
});

app.post('/api/ops/recompute-baselines', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await recomputeBaselines(c.env.DB);
  return c.json({ ok: true });
});

app.post('/api/heartbeat/:profileId', async (c) => {
  const body = await c.req.json<{ deviceId: string; ts: string; rssi?: number }>().catch(() => null);
  if (!body?.deviceId || !body?.ts) return c.text('Bad Request', 400);
  const ok = await verifyDeviceKey(c.env.DB, body.deviceId, c.req.header('X-GREENBRO-DEVICE-KEY'));
  if (!ok) return c.text('Forbidden', 403);

  await c.env.DB.prepare('INSERT INTO heartbeat (ts, device_id, rssi) VALUES (?, ?, ?)')
    .bind(body.ts, body.deviceId, body.rssi ?? null)
    .run();
  await c.env.DB.prepare('UPDATE devices SET last_seen_at=?, online=1 WHERE device_id=?')
    .bind(body.ts, body.deviceId)
    .run();

  // Let the scheduled job handle “no heartbeat” open/close; we’re only refreshing last_seen_at here.
  return c.json({ ok: true });
});

app.get('/api/alerts', async (c) => {
  const { DB } = c.env;
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }

  const url = new URL(c.req.url);
  const state = url.searchParams.get('state');
  const severity = url.searchParams.get('severity');
  const type = url.searchParams.get('type');
  const device = url.searchParams.get('deviceId');

  let sql = `SELECT a.*, GROUP_CONCAT(DISTINCT sc.client_id) AS clients
             FROM alerts a
             JOIN devices d ON a.device_id = d.device_id
             LEFT JOIN site_clients sc ON d.site_id = sc.site_id
             WHERE 1=1`;
  const bind: Array<string> = [];
  if (state) {
    sql += ' AND a.state=?';
    bind.push(state);
  }
  if (severity) {
    sql += ' AND a.severity=?';
    bind.push(severity);
  }
  if (type) {
    sql += ' AND a.type=?';
    bind.push(type);
  }
  if (device) {
    sql += ' AND a.device_id=?';
    bind.push(device);
  }

  if (auth.roles.includes('client') || auth.roles.includes('contractor')) {
    const clientIds = auth.clientIds ?? [];
    if (clientIds.length === 0) {
      return c.json([]);
    }
    const placeholders = clientIds.map(() => '?').join(',');
    sql += ` AND EXISTS (
      SELECT 1 FROM site_clients sc2 WHERE sc2.site_id = d.site_id AND sc2.client_id IN (${placeholders})
    )`;
    bind.push(...clientIds);
  }

  sql += ' GROUP BY a.alert_id ORDER BY a.opened_at DESC LIMIT 200';
  const rows = await DB.prepare(sql).bind(...bind).all();
  const results = rows.results ?? [];
  const isClientOnly =
    auth && auth.roles.includes('client') && !(auth.roles.includes('admin') || auth.roles.includes('ops'));
  const out = isClientOnly ? results.map((r) => ({ ...r, device_id: maskId(r.device_id) })) : results;
  return c.json(out);
});

app.post('/api/alerts/:id/ack', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const id = c.req.param('id');
  await c.env.DB.prepare("UPDATE alerts SET state='ack', ack_by=?, ack_at=datetime('now') WHERE alert_id=? AND state='open'")
    .bind(auth.email ?? auth.sub, id)
    .run();
  return c.json({ ok: true });
});

app.post('/api/alerts/:id/resolve', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const id = c.req.param('id');
  await c.env.DB.prepare(
    "UPDATE alerts SET state='closed', closed_at=datetime('now') WHERE alert_id=? AND state IN ('open','ack')",
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

app.post('/api/alerts/:id/comment', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const id = c.req.param('id');
  const { body } = await c.req.json<{ body: string }>();
  const cid = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO alert_comments (id, alert_id, author, ts, body) VALUES (?, ?, ?, datetime('now'), ?)`,
  )
    .bind(cid, id, auth.email ?? auth.sub, body)
    .run();
  return c.json({ ok: true, id: cid });
});

app.get('/api/admin/distinct/regions', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare(
    "SELECT DISTINCT region FROM sites WHERE region IS NOT NULL AND TRIM(region)<>'' ORDER BY region",
  ).all();
  return c.json(rows.results ?? []);
});

app.get('/api/admin/distinct/clients', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare(
    'SELECT client_id, COALESCE(name, client_id) AS name FROM clients ORDER BY name',
  ).all();
  return c.json(rows.results ?? []);
});

app.get('/api/admin/site-clients', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare('SELECT client_id, site_id FROM site_clients ORDER BY client_id, site_id').all();
  return c.json(rows.results ?? []);
});

app.post('/api/admin/site-clients', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const { clientId, siteId } = await c.req.json<{ clientId: string; siteId: string }>();
  if (!clientId || !siteId) {
    return c.text('Bad Request', 400);
  }
  await c.env.DB.prepare('INSERT OR IGNORE INTO site_clients (client_id, site_id) VALUES (?, ?)').bind(clientId, siteId).run();
  return c.json({ ok: true });
});

app.delete('/api/admin/site-clients', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('clientId');
  const siteId = url.searchParams.get('siteId');
  if (!clientId || !siteId) {
    return c.text('Bad Request', 400);
  }
  await c.env.DB.prepare('DELETE FROM site_clients WHERE client_id=? AND site_id=?').bind(clientId, siteId).run();
  return c.json({ ok: true });
});

app.get('/api/admin/sites', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare('SELECT site_id, name, region FROM sites ORDER BY site_id').all();
  return c.json(rows.results ?? []);
});

app.post('/api/admin/sites', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const { siteId, name, region } = await c.req.json<{ siteId: string; name?: string; region?: string }>();
  if (!siteId) {
    return c.text('Bad Request', 400);
  }
  await c.env.DB.prepare(
    'INSERT INTO sites (site_id, name, region) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET name=excluded.name, region=excluded.region',
  )
    .bind(siteId, name ?? null, region ?? null)
    .run();
  return c.json({ ok: true });
});

app.delete('/api/admin/sites', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const siteId = url.searchParams.get('siteId');
  if (!siteId) {
    return c.text('Bad Request', 400);
  }
  await c.env.DB.prepare('DELETE FROM sites WHERE site_id=?').bind(siteId).run();
  return c.json({ ok: true });
});

app.get('/api/overview', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const data = await buildOverviewData(c.env.DB, auth);
  return c.json(data);
});

app.get('/api/devices', async (c) => {
  const { DB } = c.env;
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }

  const url = new URL(c.req.url);
  const site = url.searchParams.get('site');
  const region = url.searchParams.get('region');
  const client = url.searchParams.get('client');
  const online = url.searchParams.get('online');

  let sql = `SELECT d.device_id, d.site_id, s.name AS site_name, s.region,
                    d.online, d.last_seen_at,
                    GROUP_CONCAT(DISTINCT sc.client_id) AS clients
             FROM devices d
             LEFT JOIN sites s ON d.site_id = s.site_id
             LEFT JOIN site_clients sc ON d.site_id = sc.site_id
             WHERE 1=1`;
  const bind: Array<string | number> = [];
  if (site) {
    sql += ' AND d.site_id=?';
    bind.push(site);
  }
  if (region) {
    sql += ' AND s.region=?';
    bind.push(region);
  }
  if (typeof online === 'string' && (online === '0' || online === '1')) {
    sql += ' AND d.online=?';
    bind.push(Number(online));
  }
  if (client) {
    sql += ' AND EXISTS (SELECT 1 FROM site_clients sc2 WHERE sc2.site_id = d.site_id AND sc2.client_id = ?)';
    bind.push(client);
  }

  if (auth.roles.includes('client') || auth.roles.includes('contractor')) {
    const clientIds = auth.clientIds ?? [];
    if (clientIds.length === 0) {
      return c.json([]);
    }
    const placeholders = clientIds.map(() => '?').join(',');
    sql += ` AND EXISTS (SELECT 1 FROM site_clients sc3 WHERE sc3.site_id = d.site_id AND sc3.client_id IN (${placeholders}))`;
    bind.push(...clientIds);
  }

  sql += ' GROUP BY d.device_id ORDER BY (d.last_seen_at IS NULL), d.last_seen_at DESC LIMIT 500';
  const rows = await DB.prepare(sql).bind(...bind).all();
  const results = rows.results ?? [];
  const isClientOnly =
    auth && auth.roles.includes('client') && !(auth.roles.includes('admin') || auth.roles.includes('ops'));
  const out = isClientOnly ? results.map((r) => ({ ...r, device_id: maskId(r.device_id) })) : results;
  return c.json(out);
});

app.post('/api/commissioning/:deviceId/report', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops', 'contractor']);
  const deviceId = c.req.param('deviceId');
  const payload = await c.req.json<Omit<CommissioningPayload, 'deviceId'>>();
  const res = await generateCommissioningPDF(c.env, { ...payload, deviceId });
  return c.json(res);
});

app.post('/api/reports/incident', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const url = new URL(c.req.url);
  const siteId = url.searchParams.get('siteId');
  const hoursParam = url.searchParams.get('hours');
  if (!siteId) {
    return c.text('siteId required', 400);
  }

  const hours = Number(hoursParam ?? '24');
  const windowHours = Number.isFinite(hours) && hours > 0 ? hours : 24;

  const site = await c.env.DB.prepare('SELECT site_id, name, region FROM sites WHERE site_id=?')
    .bind(siteId)
    .first<{ site_id: string; name: string | null; region: string | null }>();

  const counts = await c.env.DB.prepare(
    `SELECT severity, COUNT(*) as n
     FROM alerts
     WHERE device_id IN (SELECT device_id FROM devices WHERE site_id=?) AND state IN ('open','ack')
     GROUP BY severity`,
  )
    .bind(siteId)
    .all<{ severity: string; n: number }>();

  const top = await c.env.DB.prepare(
    `SELECT d.device_id, SUM(CASE WHEN a.state IN ('open','ack') THEN 1 ELSE 0 END) as open_count
     FROM devices d LEFT JOIN alerts a ON a.device_id = d.device_id
     WHERE d.site_id=?
     GROUP BY d.device_id
     ORDER BY open_count DESC
     LIMIT 5`,
  )
    .bind(siteId)
    .all<{ device_id: string; open_count: number | null }>();

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let y = 800;
  const draw = (text: string, size = 12) => {
    page.drawText(text, { x: 40, y, size, font });
    y -= size + 6;
  };

  draw(`Incident report — ${site?.name ?? siteId}`, 18);
  draw(`Region: ${site?.region ?? '—'}`);
  draw(`Window: last ${Math.round(windowHours * 10) / 10}h`);
  y -= 6;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 1 });
  y -= 12;

  const severityRows = counts.results ?? [];
  draw('Open alerts by severity:', 14);
  if (severityRows.length === 0) {
    draw('• None');
  } else {
    for (const row of severityRows) {
      draw(`• ${row.severity}: ${row.n}`);
    }
  }

  y -= 6;
  const topRows = top.results ?? [];
  draw('Top devices:', 14);
  if (topRows.length === 0) {
    draw('• None');
  } else {
    for (const row of topRows) {
      const count = row.open_count ?? 0;
      draw(`• ${row.device_id}: ${count}`);
    }
  }

  const generatedAt = new Date().toISOString();
  y -= 6;
  draw(`Generated at: ${generatedAt}`);

  const bytes = await pdf.save();
  const key = `reports/incident_${siteId}_${Date.now()}.pdf`;
  await c.env.REPORTS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });

  return c.json({
    ok: true,
    key,
    path: `/api/reports/${key}`,
    url: `/api/reports/${key}`,
    generatedAt,
  });
});

app.get('/api/reports/*', async (c) => {
  const key = c.req.path.replace('/api/reports/', '');
  const obj = await c.env.REPORTS.get(key);
  if (!obj) {
    return c.text('Not found', 404);
  }
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    },
  });
});

app.get('/', async (c) => {
  const data = await buildOverviewData(c.env.DB);
  return c.render(<OverviewPage data={data} />);
});

app.get('/ops', async (c) => {
  const { DB } = c.env;
  const ingestOk = await DB.prepare(
    "SELECT COUNT(*) as n FROM ops_metrics WHERE route='/api/ingest' AND status_code BETWEEN 200 AND 299",
  )
    .first<{ n: number }>()
    .catch(() => null);
  const ingestAll = await DB.prepare("SELECT COUNT(*) as n FROM ops_metrics WHERE route='/api/ingest'")
    .first<{ n: number }>()
    .catch(() => null);

  const total = ingestAll?.n ?? 0;
  let p95IngestMs = 0;
  if (total > 0) {
    const offset = Math.max(0, Math.floor(0.95 * (total - 1)));
    const p95Row = await DB.prepare(
      "SELECT duration_ms FROM ops_metrics WHERE route='/api/ingest' ORDER BY duration_ms LIMIT 1 OFFSET ?",
    )
      .bind(offset)
      .first<{ duration_ms: number }>()
      .catch(() => null);
    p95IngestMs = p95Row?.duration_ms ?? 0;
  }

  const lastSeen = await DB.prepare(
    "SELECT MAX(strftime('%s','now') - strftime('%s', last_seen_at)) as age FROM devices WHERE online=1",
  )
    .first<{ age: number | null }>()
    .catch(() => null);

  const gauges = {
    ingestSuccessPct: total > 0 ? (100 * (ingestOk?.n ?? 0)) / total : 100,
    p95IngestMs,
    heartbeatFreshnessMin: (lastSeen?.age ?? 0) / 60,
  };

  return c.render(<OpsPage gauges={gauges} />);
});

app.get('/alerts', async (c) => {
  const { DB } = c.env;
  const auth = await (async () => {
    const jwt = c.req.header('Cf-Access-Jwt-Assertion');
    if (!jwt) return null;
    try {
      return await verifyAccessJWT(c.env, jwt);
    } catch {
      return null;
    }
  })();

  const url = new URL(c.req.url);
  const state = url.searchParams.get('state') ?? undefined;
  const severity = url.searchParams.get('severity') ?? undefined;
  const type = url.searchParams.get('type') ?? undefined;
  const deviceId = url.searchParams.get('deviceId') ?? undefined;

  let sql = `SELECT a.*, GROUP_CONCAT(DISTINCT sc.client_id) AS clients
             FROM alerts a
             JOIN devices d ON a.device_id = d.device_id
             LEFT JOIN site_clients sc ON d.site_id = sc.site_id
             WHERE 1=1`;
  const bind: Array<string> = [];
  if (state) {
    sql += ' AND a.state=?';
    bind.push(state);
  }
  if (severity) {
    sql += ' AND a.severity=?';
    bind.push(severity);
  }
  if (type) {
    sql += ' AND a.type=?';
    bind.push(type);
  }
  if (deviceId) {
    sql += ' AND a.device_id=?';
    bind.push(deviceId);
  }

  if (auth && (auth.roles.includes('client') || auth.roles.includes('contractor'))) {
    const clientIds = auth.clientIds ?? [];
    if (clientIds.length === 0) {
      return c.render(<AlertsPage alerts={[]} filters={{ state, severity, type, deviceId }} />);
    }
    const placeholders = clientIds.map(() => '?').join(',');
    sql += ` AND EXISTS (SELECT 1 FROM site_clients sc2 WHERE sc2.site_id = d.site_id AND sc2.client_id IN (${placeholders}))`;
    bind.push(...clientIds);
  }

  sql += ' GROUP BY a.alert_id ORDER BY a.opened_at DESC LIMIT 100';
  const rows = await DB.prepare(sql).bind(...bind).all();
  const results = rows.results ?? [];
  const isClientOnly =
    auth && auth.roles.includes('client') && !(auth.roles.includes('admin') || auth.roles.includes('ops'));
  const alerts = isClientOnly ? results.map((r) => ({ ...r, device_id: maskId(r.device_id) })) : results;
  return c.render(<AlertsPage alerts={alerts} filters={{ state, severity, type, deviceId }} />);
});

app.get('/devices', async (c) => {
  const { DB } = c.env;
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }

  let sql = `SELECT d.device_id, d.site_id, s.name AS site_name, s.region,
                    d.online, d.last_seen_at,
                    GROUP_CONCAT(DISTINCT sc.client_id) AS clients
             FROM devices d
             LEFT JOIN sites s ON d.site_id = s.site_id
             LEFT JOIN site_clients sc ON d.site_id = sc.site_id
             WHERE 1=1`;
  const bind: Array<string> = [];

  if (auth.roles.includes('client') || auth.roles.includes('contractor')) {
    const clientIds = auth.clientIds ?? [];
    if (clientIds.length === 0) {
      return c.render(<DevicesPage rows={[]} />);
    }
    const placeholders = clientIds.map(() => '?').join(',');
    sql += ` AND EXISTS (SELECT 1 FROM site_clients sc2 WHERE sc2.site_id = d.site_id AND sc2.client_id IN (${placeholders}))`;
    bind.push(...clientIds);
  }

  sql += ' GROUP BY d.device_id ORDER BY (d.last_seen_at IS NULL), d.last_seen_at DESC LIMIT 500';
  const rows = await DB.prepare(sql).bind(...bind).all();
  const results = rows.results ?? [];
  const isClientOnly =
    auth && auth.roles.includes('client') && !(auth.roles.includes('admin') || auth.roles.includes('ops'));
  const out = isClientOnly ? results.map((r) => ({ ...r, device_id: maskId(r.device_id) })) : results;
  return c.render(<DevicesPage rows={out} />);
});

app.get('/admin/sites', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  return c.render(<AdminSitesPage />);
});

function createEmptyOverview(): OverviewData {
  return {
    kpis: { onlinePct: 0, openAlerts: 0, avgCop: null },
    sites: [],
    series: { deltaT: [], cop: [] },
  };
}

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

async function buildOverviewData(DB: D1Database, auth?: AccessContext): Promise<OverviewData> {
  const restricted = !!auth && (auth.roles.includes('client') || auth.roles.includes('contractor'));
  let siteFilter: string[] | null = null;

  if (restricted) {
    const clientIds = auth?.clientIds ?? [];
    if (clientIds.length === 0) {
      return createEmptyOverview();
    }
    const placeholders = clientIds.map(() => '?').join(',');
    const siteRows = await DB.prepare(
      `SELECT DISTINCT site_id FROM site_clients WHERE client_id IN (${placeholders}) AND site_id IS NOT NULL`,
    )
      .bind(...clientIds)
      .all();
    const sites = (siteRows.results ?? [])
      .map((row: any) => row.site_id as string | null)
      .filter((siteId): siteId is string => !!siteId);
    if (sites.length === 0) {
      return createEmptyOverview();
    }
    siteFilter = [...new Set(sites)];
  }

  const bindSites = siteFilter ?? [];
  const sitePlaceholder = siteFilter ? siteFilter.map(() => '?').join(',') : '';

  const deviceRow = await DB.prepare(
    `SELECT SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) as onlineCount, COUNT(*) as totalCount FROM devices${
      siteFilter ? ` WHERE site_id IN (${sitePlaceholder})` : ''
    }`,
  )
    .bind(...bindSites)
    .first<{ onlineCount: number | null; totalCount: number | null }>()
    .catch(() => null);

  const openAlertsRow = await DB.prepare(
    siteFilter
      ? `SELECT COUNT(*) as n FROM alerts a JOIN devices d ON d.device_id = a.device_id WHERE a.state IN ('open','ack') AND d.site_id IN (${sitePlaceholder})`
      : `SELECT COUNT(*) as n FROM alerts WHERE state IN ('open','ack')`,
  )
    .bind(...bindSites)
    .first<{ n: number | null }>()
    .catch(() => null);

  const avgCopRow = await DB.prepare(
    siteFilter
      ? `SELECT AVG(ls.cop) as avgCop FROM latest_state ls JOIN devices d ON d.device_id = ls.device_id WHERE ls.cop IS NOT NULL AND d.site_id IN (${sitePlaceholder})`
      : `SELECT AVG(cop) as avgCop FROM latest_state WHERE cop IS NOT NULL`,
  )
    .bind(...bindSites)
    .first<{ avgCop: number | null }>()
    .catch(() => null);

  const telemetryRows = await DB.prepare(
    siteFilter
      ? `SELECT t.ts, t.deltaT, t.cop FROM telemetry t JOIN devices d ON d.device_id = t.device_id WHERE t.ts >= datetime('now', '-24 hours') AND d.site_id IN (${sitePlaceholder}) ORDER BY t.ts DESC LIMIT 240`
      : `SELECT ts, deltaT, cop FROM telemetry WHERE ts >= datetime('now', '-24 hours') ORDER BY ts DESC LIMIT 240`,
  )
    .bind(...bindSites)
    .all()
    .catch(() => null);

  const telemetry = (telemetryRows?.results ?? []).reverse();
  const deltaSeries = telemetry.map((row: any) => ({ ts: row.ts as string, value: toNumber(row.deltaT) }));
  const copSeries = telemetry.map((row: any) => ({ ts: row.ts as string, value: toNumber(row.cop) }));

  const severityRows = await DB.prepare(
    siteFilter
      ? `SELECT d.site_id AS site_id,
               MAX(CASE a.severity WHEN 'critical' THEN 3 WHEN 'major' THEN 2 WHEN 'minor' THEN 1 ELSE 0 END) AS severity_rank,
               COUNT(*) AS open_alerts
         FROM alerts a
         JOIN devices d ON d.device_id = a.device_id
         WHERE a.state IN ('open','ack') AND d.site_id IN (${sitePlaceholder})
         GROUP BY d.site_id`
      : `SELECT d.site_id AS site_id,
               MAX(CASE a.severity WHEN 'critical' THEN 3 WHEN 'major' THEN 2 WHEN 'minor' THEN 1 ELSE 0 END) AS severity_rank,
               COUNT(*) AS open_alerts
         FROM alerts a
         JOIN devices d ON d.device_id = a.device_id
         WHERE a.state IN ('open','ack')
         GROUP BY d.site_id`,
  )
    .bind(...bindSites)
    .all()
    .catch(() => null);

  const severityMap = new Map<string, { rank: number; openAlerts: number }>();
  for (const row of severityRows?.results ?? []) {
    const siteId = (row as any).site_id as string | null;
    if (!siteId) continue;
    const rank = toNumber((row as any).severity_rank) ?? 0;
    const openAlerts = toNumber((row as any).open_alerts) ?? 0;
    severityMap.set(siteId, { rank, openAlerts });
  }

  const siteRows = await DB.prepare(
    `WITH all_sites AS (
      SELECT site_id FROM sites WHERE site_id IS NOT NULL
      UNION
      SELECT DISTINCT site_id FROM devices WHERE site_id IS NOT NULL
      UNION
      SELECT DISTINCT site_id FROM site_clients WHERE site_id IS NOT NULL
    )
    SELECT a.site_id, s.name, s.region, s.lat, s.lon,
           COALESCE(cnt.total_devices, 0) AS device_count,
           COALESCE(cnt.online_devices, 0) AS online_count
    FROM all_sites a
    LEFT JOIN sites s ON s.site_id = a.site_id
    LEFT JOIN (
      SELECT site_id,
             COUNT(*) AS total_devices,
             SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) AS online_devices
      FROM devices
      GROUP BY site_id
    ) cnt ON cnt.site_id = a.site_id
    ${siteFilter ? `WHERE a.site_id IN (${sitePlaceholder})` : ''}
    ORDER BY a.site_id`,
  )
    .bind(...bindSites)
    .all()
    .catch(() => null);

  const sites: OverviewData['sites'] = [];
  const seenSites = new Set<string>();

  for (const row of siteRows?.results ?? []) {
    const siteId = (row as any).site_id as string | null;
    if (!siteId) continue;
    seenSites.add(siteId);
    const stats = severityMap.get(siteId);
    const rank = stats?.rank ?? 0;
    const severity: 'critical' | 'major' | 'minor' | null =
      rank >= 3 ? 'critical' : rank >= 2 ? 'major' : rank >= 1 ? 'minor' : null;
    const deviceCount = toNumber((row as any).device_count) ?? 0;
    const status: 'critical' | 'major' | 'ok' | 'empty' =
      deviceCount === 0 ? 'empty' : severity === 'critical' ? 'critical' : severity === 'major' ? 'major' : 'ok';
    sites.push({
      siteId,
      name: ((row as any).name as string) ?? null,
      region: ((row as any).region as string) ?? null,
      lat: toNumber((row as any).lat),
      lon: toNumber((row as any).lon),
      deviceCount,
      onlineCount: toNumber((row as any).online_count) ?? 0,
      openAlerts: stats?.openAlerts ?? 0,
      maxSeverity: severity,
      status,
    });
  }

  if (siteFilter) {
    for (const siteId of siteFilter) {
      if (seenSites.has(siteId)) continue;
      const stats = severityMap.get(siteId);
      const rank = stats?.rank ?? 0;
      const severity: 'critical' | 'major' | 'minor' | null =
        rank >= 3 ? 'critical' : rank >= 2 ? 'major' : rank >= 1 ? 'minor' : null;
      const status: 'critical' | 'major' | 'ok' | 'empty' =
        severity === 'critical' ? 'critical' : severity === 'major' ? 'major' : 'empty';
      sites.push({
        siteId,
        name: null,
        region: null,
        lat: null,
        lon: null,
        deviceCount: 0,
        onlineCount: 0,
        openAlerts: stats?.openAlerts ?? 0,
        maxSeverity: severity,
        status,
      });
    }
  }

  sites.sort((a, b) => a.siteId.localeCompare(b.siteId));

  const totalDevices = toNumber(deviceRow?.totalCount) ?? 0;
  const onlineCount = toNumber(deviceRow?.onlineCount) ?? 0;
  const openAlerts = toNumber(openAlertsRow?.n) ?? 0;
  const avgCop = toNumber(avgCopRow?.avgCop);

  return {
    kpis: {
      onlinePct: totalDevices > 0 ? (100 * onlineCount) / totalDevices : 0,
      openAlerts,
      avgCop: avgCop ?? null,
    },
    sites,
    series: {
      deltaT: deltaSeries,
      cop: copSeries,
    },
  };
}

async function verifyDeviceKey(DB: D1Database, deviceId: string, key: string | null | undefined) {
  if (!key) return false;
  const row = await DB.prepare('SELECT key_hash, device_key_hash FROM devices WHERE device_id=?')
    .bind(deviceId)
    .first<{ key_hash?: string | null; device_key_hash?: string | null }>();
  const stored = row?.key_hash ?? row?.device_key_hash;
  if (!stored) return false;
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(key))
    .then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''))
    .then((digest) => digest === stored);
}

async function isDuplicate(DB: D1Database, key: string) {
  await DB.exec(`CREATE TABLE IF NOT EXISTS idem (k TEXT PRIMARY KEY, ts TEXT)`);
  const hit = await DB.prepare('SELECT k FROM idem WHERE k=?').bind(key).first();
  if (hit) return true;
  await DB.prepare("INSERT OR IGNORE INTO idem (k, ts) VALUES (?, datetime('now'))").bind(key).run();
  return false;
}

async function recomputeBaselines(DB: D1Database) {
  await DB.exec(`CREATE TABLE IF NOT EXISTS baselines_hourly (
    device_id TEXT,
    how INTEGER,
    dt_mean REAL,
    dt_std REAL,
    dt_n INTEGER,
    cop_mean REAL,
    cop_std REAL,
    cop_n INTEGER,
    PRIMARY KEY(device_id, how)
  )`);

  const rows = await DB.prepare(`
    SELECT
      device_id,
      ((CAST(strftime('%w', ts) AS INT) + 6) % 7) * 24 + CAST(strftime('%H', ts) AS INT) AS how,
      AVG(deltaT) AS dt_mean,
      AVG(deltaT * deltaT) AS dt_sq_mean,
      COUNT(deltaT) AS dt_n,
      AVG(cop) AS cop_mean,
      AVG(cop * cop) AS cop_sq_mean,
      COUNT(cop) AS cop_n
    FROM telemetry
    WHERE ts >= datetime('now','-7 days')
    GROUP BY device_id, how
  `).all<{
    device_id: string;
    how: number;
    dt_mean: number | null;
    dt_sq_mean: number | null;
    dt_n: number;
    cop_mean: number | null;
    cop_sq_mean: number | null;
    cop_n: number;
  }>();

  const results = rows.results ?? [];
  if (results.length === 0) {
    return;
  }

  await DB.batch(
    results.map((row) => {
      const dtStd =
        row.dt_n > 1 && row.dt_mean != null && row.dt_sq_mean != null
          ? Math.sqrt(Math.max(0, row.dt_sq_mean - row.dt_mean * row.dt_mean))
          : null;
      const copStd =
        row.cop_n > 1 && row.cop_mean != null && row.cop_sq_mean != null
          ? Math.sqrt(Math.max(0, row.cop_sq_mean - row.cop_mean * row.cop_mean))
          : null;

      return DB.prepare(`
        INSERT INTO baselines_hourly (device_id, how, dt_mean, dt_std, dt_n, cop_mean, cop_std, cop_n)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, how) DO UPDATE SET
          dt_mean=excluded.dt_mean,
          dt_std=excluded.dt_std,
          dt_n=excluded.dt_n,
          cop_mean=excluded.cop_mean,
          cop_std=excluded.cop_std,
          cop_n=excluded.cop_n
      `).bind(
        row.device_id,
        row.how,
        row.dt_mean,
        dtStd,
        row.dt_n,
        row.cop_mean,
        copStd,
        row.cop_n,
      );
    }),
  );
}

function hourOfWeek(tsIso: string) {
  const d = new Date(tsIso);
  const day = (d.getUTCDay() + 6) % 7;
  return day * 24 + d.getUTCHours();
}

function z(value: number, mean?: number | null, std?: number | null) {
  if (std == null || std === 0) return 0;
  return (value - (mean ?? 0)) / std;
}

function computeDerived(metrics: TelemetryPayload['metrics']): Derived {
  const supply = metrics.supplyC ?? null;
  const ret = metrics.returnC ?? null;
  const flow = metrics.flowLps ?? null;
  const power = metrics.powerKW ?? null;

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

export async function queue(batch: MessageBatch<IngestMessage>, env: Env, ctx: ExecutionContext) {
  await baseQueueHandler(batch, env, ctx);

  for (const message of batch.messages) {
    if (message.body?.kind !== 'telemetry') continue;
    const telemetry = message.body.body;
    try {
      const latest = await env.DB.prepare(
        'SELECT deltaT, thermalKW, cop, cop_quality as copQuality FROM latest_state WHERE device_id=?',
      )
        .bind(telemetry.deviceId)
        .first<{
          deltaT: number | null;
          thermalKW: number | null;
          cop: number | null;
          copQuality: 'measured' | 'estimated' | null;
        }>();
      const derived: Derived = latest ?? { deltaT: null, thermalKW: null, cop: null, copQuality: null };
      await evaluateTelemetryAlerts(env, telemetry, derived);
    } catch (error) {
      console.error('alert evaluation error', error);
    }
  }
}

export async function scheduled(_ctrl: ScheduledController, env: Env, _ctx: ExecutionContext) {
  await evaluateHeartbeatAlerts(env, new Date().toISOString());
}

export default {
  fetch: app.fetch,
  queue,
  scheduled,
};
