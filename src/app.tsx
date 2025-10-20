/** @jsxImportSource hono/jsx */
/** @jsxRuntime automatic */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, IngestMessage, TelemetryPayload } from './types';
import { verifyAccessJWT, requireRole, type AccessContext } from './rbac';
import { DeviceStateDO } from './do';
import { evaluateTelemetryAlerts, evaluateHeartbeatAlerts, type Derived } from './alerts';
import { generateCommissioningPDF, type CommissioningPayload } from './pdf';
import { renderer, OverviewPage, AlertsPage } from './ssr';
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

app.use('*', renderer());

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

  let sql = 'SELECT * FROM alerts WHERE 1=1';
  const bind: Array<string> = [];
  if (state) {
    sql += ' AND state=?';
    bind.push(state);
  }
  if (severity) {
    sql += ' AND severity=?';
    bind.push(severity);
  }
  if (type) {
    sql += ' AND type=?';
    bind.push(type);
  }
  if (device) {
    sql += ' AND device_id=?';
    bind.push(device);
  }

  if (auth.roles.includes('client') || auth.roles.includes('contractor')) {
    const allowedSites = auth.clientIds ?? [];
    if (allowedSites.length === 0) {
      return c.json([]);
    }
    const placeholders = allowedSites.map(() => '?').join(',');
    sql += ` AND device_id IN (SELECT device_id FROM devices WHERE site_id IN (${placeholders}))`;
    bind.push(...allowedSites);
  }

  sql += ' ORDER BY opened_at DESC LIMIT 200';
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

  let sql = 'SELECT * FROM alerts WHERE 1=1';
  const bind: Array<string> = [];
  if (state) {
    sql += ' AND state=?';
    bind.push(state);
  }
  if (severity) {
    sql += ' AND severity=?';
    bind.push(severity);
  }
  if (type) {
    sql += ' AND type=?';
    bind.push(type);
  }
  if (deviceId) {
    sql += ' AND device_id=?';
    bind.push(deviceId);
  }

  if (auth && (auth.roles.includes('client') || auth.roles.includes('contractor'))) {
    const allowedSites = auth.clientIds ?? [];
    if (allowedSites.length === 0) {
      return c.render(<AlertsPage alerts={[]} filters={{ state, severity, type, deviceId }} />);
    }
    const placeholders = allowedSites.map(() => '?').join(',');
    sql += ` AND device_id IN (SELECT device_id FROM devices WHERE site_id IN (${placeholders}))`;
    bind.push(...allowedSites);
  }

  sql += ' ORDER BY opened_at DESC LIMIT 100';
  const rows = await DB.prepare(sql).bind(...bind).all();
  return c.render(<AlertsPage alerts={rows.results ?? []} filters={{ state, severity, type, deviceId }} />);
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
