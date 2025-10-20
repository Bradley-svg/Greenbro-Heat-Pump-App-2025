/** @jsxImportSource hono/jsx */
/** @jsxRuntime automatic */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, IngestMessage, TelemetryPayload } from './types';
import { verifyAccessJWT, requireRole, type AccessContext } from './rbac';
import { DeviceStateDO } from './do';
import { evaluateTelemetryAlerts, evaluateHeartbeatAlerts, type Derived } from './alerts';
import { generateCommissioningPDF, type CommissioningPayload } from './pdf';
import { renderer, OverviewPage, AlertsPage, DevicesPage, AdminSitesPage } from './ssr';
import { handleQueueBatch as baseQueueHandler } from './queue';

void DeviceStateDO;

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

app.post('/api/ingest/:profileId', async (c) => {
  const { DB, INGEST_QUEUE } = c.env;
  const profileId = c.req.param('profileId');
  const body = await c.req.json<TelemetryPayload>();

  if (!body?.deviceId || !body?.ts) {
    return c.text('Bad Request', 400);
  }

  const devKey = c.req.header('X-GREENBRO-DEVICE-KEY');
  if (!devKey) {
    return c.text('Unauthorized (device key missing)', 401);
  }
  const ok = await verifyDeviceKey(DB, body.deviceId, devKey);
  if (!ok) {
    return c.text('Unauthorized (device key invalid)', 401);
  }

  const msg: IngestMessage = { kind: 'telemetry', profileId, body };
  await INGEST_QUEUE.send(msg);
  return c.text('Accepted', 202);
});

app.post('/api/heartbeat/:profileId', async (c) => {
  const { DB, INGEST_QUEUE } = c.env;
  const profileId = c.req.param('profileId');
  const body = await c.req.json<{ deviceId: string; ts: string; rssi?: number }>();

  if (!body?.deviceId || !body?.ts) {
    return c.text('Bad Request', 400);
  }

  const devKey = c.req.header('X-GREENBRO-DEVICE-KEY');
  if (!devKey) {
    return c.text('Unauthorized (device key missing)', 401);
  }
  const ok = await verifyDeviceKey(DB, body.deviceId, devKey);
  if (!ok) {
    return c.text('Unauthorized (device key invalid)', 401);
  }

  const msg: IngestMessage = { kind: 'heartbeat', profileId, body };
  await INGEST_QUEUE.send(msg);
  return c.text('Accepted', 202);
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
  return c.json(rows.results ?? []);
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
  await c.env.DB.prepare("UPDATE alerts SET state='closed', closed_at=datetime('now') WHERE alert_id=? AND state IN ('open','ack')")
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
  return c.json(rows.results ?? []);
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
  const { DB } = c.env;
  const openAlerts = await DB.prepare("SELECT COUNT(*) as n FROM alerts WHERE state IN ('open','ack')").first<{ n: number }>();
  const online = await DB.prepare('SELECT COUNT(*) as onl FROM devices WHERE online=1').first<{ onl: number }>();
  const total = await DB.prepare('SELECT COUNT(*) as tot FROM devices').first<{ tot: number }>();
  const kpis = {
    onlinePct: total?.tot ? (100 * (online?.onl ?? 0) / total.tot) : 0,
    openAlerts: openAlerts?.n ?? 0,
    avgCop: null,
  };
  return c.render(<OverviewPage kpis={kpis} />);
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
  return c.render(<AlertsPage alerts={rows.results ?? []} filters={{ state, severity, type, deviceId }} />);
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
  return c.render(<DevicesPage rows={rows.results ?? []} />);
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

async function verifyDeviceKey(DB: D1Database, deviceId: string, providedKey: string): Promise<boolean> {
  const enc = new TextEncoder();
  const data = enc.encode(providedKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const row = await DB.prepare('SELECT device_key_hash FROM devices WHERE device_id=?')
    .bind(deviceId)
    .first<{ device_key_hash: string }>();
  return row?.device_key_hash === hex;
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
