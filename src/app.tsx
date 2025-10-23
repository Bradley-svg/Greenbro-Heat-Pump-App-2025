/** @jsxImportSource hono/jsx */
/** @jsxRuntime automatic */
import type { ExecutionContext, MessageBatch, ScheduledEvent } from '@cloudflare/workers-types';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Env, IngestMessage, TelemetryPayload } from './types';
import { verifyAccessJWT, requireRole, type AccessContext } from './rbac';
import { DeviceStateDO, DeviceDO } from './do';
import { evaluateTelemetryAlerts, evaluateHeartbeatAlerts, type Derived } from './alerts';
import {
  generateCommissioningPDF,
  generateClientMonthlyReport,
  generateIncidentReportV2,
  type ClientMonthlyReportPayload,
  type CommissioningPayload,
  type IncidentReportV2Payload,
} from './pdf';
import { brandCss, brandEmail, brandLogoSvg, brandLogoMonoSvg } from './brand';
import {
  renderer,
  OverviewPage,
  AlertsPage,
  DevicesPage,
  AdminSitesPage,
  AdminEmailPage,
  AdminMaintenancePage,
  AdminArchivePage,
  AdminPresetsPage,
  AdminSettingsPage,
  AdminReportsPage,
  AdminReportsOutboxPage,
  AdminReportsHistoryPage,
  ClientSloPage,
  OpsPage,
  type OverviewData,
  type OpsSnapshot,
  type ClientSloSummary,
  type ReportHistoryRow,
  type AdminArchiveRow,
} from './ssr';
import { handleQueueBatch as baseQueueHandler } from './queue';
import { sweepIncidents } from './incidents';

void DeviceStateDO;
void DeviceDO;

function maskId(id: string) {
  if (!id) return id as any;
  return id.length <= 5 ? `•••${id.slice(-2)}` : `${id.slice(0, 3)}…${id.slice(-2)}`;
}

function escapeForLike(value: string) {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

async function getSetting(DB: D1Database, key: string) {
  const r = await DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
async function setSetting(DB: D1Database, key: string, value: string) {
  await DB.prepare(
    "INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
  ).bind(key, value).run();
}

const isStr = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;

function validatePresets(arr: unknown): string | null {
  if (!Array.isArray(arr)) return 'Presets must be an array.';
  for (const [i, p] of arr.entries()) {
    if (!p || typeof p !== 'object') return `Preset #${i + 1} must be an object.`;
    const id = (p as any).id;
    const name = (p as any).name;
    const cols = (p as any).cols;
    if (!isStr(id)) return `Preset #${i + 1} missing id.`;
    if (!isStr(name)) return `Preset #${i + 1} missing name.`;
    if (!Array.isArray(cols) || !cols.every(isStr)) {
      return `Preset #${i + 1} cols must be array of strings.`;
    }
  }
  return null;
}

function dedupeRecipients(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, trimmed);
    }
  }
  return Array.from(seen.values());
}

function parseRecipientList(value?: string | null): string[] {
  if (!value) {
    return [];
  }
  const parts = value.split(/[,;\n]+/);
  return dedupeRecipients(parts);
}

function canAccessClient(auth: AccessContext, clientId: string) {
  if (auth.roles.includes('admin') || auth.roles.includes('ops')) {
    return true;
  }
  if ((auth.roles.includes('client') || auth.roles.includes('contractor')) && auth.clientIds) {
    return auth.clientIds.includes(clientId);
  }
  return false;
}

type ReportDeliveryLogEntry = {
  type: string;
  status: string;
  clientId?: string | null;
  siteId?: string | null;
  path?: string | null;
  subject?: string | null;
  to?: string[] | string | null;
  meta?: Record<string, unknown> | null;
};

type ReportDeliveryFilters = {
  clientId?: string | null;
  siteId?: string | null;
  type?: string | null;
  status?: string | null;
  limit?: number | null;
};

async function logReportDelivery(DB: D1Database, entry: ReportDeliveryLogEntry) {
  try {
    const toList =
      entry.to == null
        ? []
        : Array.isArray(entry.to)
          ? dedupeRecipients(entry.to)
          : parseRecipientList(entry.to);
    const recipients = toList.length > 0 ? toList.join(', ') : null;
    const metaJson = entry.meta ? JSON.stringify(entry.meta) : null;
    await DB.prepare(
      `INSERT INTO report_deliveries (delivery_id, type, client_id, site_id, path, recipients, subject, status, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        entry.type,
        entry.clientId ?? null,
        entry.siteId ?? null,
        entry.path ?? null,
        recipients,
        entry.subject ?? null,
        entry.status,
        metaJson,
      )
      .run();
  } catch (error) {
    console.warn('logReportDelivery failed', error);
  }
}

async function listReportDeliveries(DB: D1Database, filters: ReportDeliveryFilters = {}): Promise<ReportHistoryRow[]> {
  let sql =
    'SELECT delivery_id, type, client_id, site_id, path, recipients, subject, status, meta_json, created_at FROM report_deliveries WHERE 1=1';
  const bind: Array<string | number> = [];
  if (filters.clientId) {
    sql += ' AND client_id = ?';
    bind.push(filters.clientId);
  }
  if (filters.siteId) {
    sql += ' AND site_id = ?';
    bind.push(filters.siteId);
  }
  if (filters.type) {
    sql += ' AND type = ?';
    bind.push(filters.type);
  }
  if (filters.status) {
    sql += ' AND status = ?';
    bind.push(filters.status);
  }
  const limit = (() => {
    const raw = filters.limit ?? 100;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return 100;
    }
    return Math.min(Math.max(Math.floor(parsed), 1), 500);
  })();
  sql += ' ORDER BY created_at DESC LIMIT ?';
  bind.push(limit);

  const rows = await DB.prepare(sql)
    .bind(...bind)
    .all<{
      delivery_id: string;
      type: string;
      client_id: string | null;
      site_id: string | null;
      path: string | null;
      recipients: string | null;
      subject: string | null;
      status: string;
      meta_json: string | null;
      created_at: string;
    }>();

  const parseRecipients = (value: string | null): string[] => {
    if (!value) return [];
    return value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  };

  return (rows.results ?? []).map((row) => {
    let meta: Record<string, unknown> | null = null;
    if (row.meta_json) {
      try {
        const parsed = JSON.parse(row.meta_json);
        if (parsed && typeof parsed === 'object') {
          meta = parsed as Record<string, unknown>;
        }
      } catch (error) {
        console.warn('report history meta parse failed', error);
      }
    }
    return {
      delivery_id: row.delivery_id,
      type: row.type,
      client_id: row.client_id ?? null,
      site_id: row.site_id ?? null,
      path: row.path ?? null,
      subject: row.subject ?? null,
      status: row.status,
      recipients: parseRecipients(row.recipients ?? null),
      meta,
      created_at: row.created_at,
    };
  });
}

type EmailSettings = { webhook: string | null; from: string | null };

async function loadEmailSettings(DB: D1Database): Promise<EmailSettings> {
  const [webhook, from] = await Promise.all([
    getSetting(DB, 'email_webhook_url'),
    getSetting(DB, 'email_from'),
  ]);
  return { webhook, from };
}

async function sendEmail(
  env: Env,
  to: string[] | string,
  subject: string,
  text: string,
  settings?: EmailSettings,
  html?: string,
): Promise<boolean> {
  const recipients = Array.isArray(to) ? dedupeRecipients(to) : parseRecipientList(to);
  if (recipients.length === 0) {
    return false;
  }
  const cfg = settings ?? (await loadEmailSettings(env.DB));
  if (!cfg.webhook || !cfg.from) {
    return false;
  }
  try {
    const payload: Record<string, unknown> = {
      from: cfg.from,
      to: recipients,
      subject,
      text,
    };
    if (html) {
      payload.html = html;
    }
    await fetch(cfg.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return true;
  } catch (error) {
    console.error('sendEmail failed', error);
    return false;
  }
}

async function notifyOps(env: Env, message: string) {
  const url = await getSetting(env.DB, 'ops_webhook_url');
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch {}
}

async function collectSiteRecipients(DB: D1Database, siteId: string) {
  const rows = await DB.prepare(
    `SELECT c.client_id, c.name, cs.report_recipients
       FROM site_clients sc
       JOIN clients c ON c.client_id = sc.client_id
       LEFT JOIN client_slos cs ON cs.client_id = c.client_id
      WHERE sc.site_id = ?`,
  )
    .bind(siteId)
    .all<{ client_id: string; name: string | null; report_recipients: string | null }>();

  const clients: Array<{ id: string; name: string | null }> = [];
  let recipients: string[] = [];
  for (const row of rows.results ?? []) {
    clients.push({ id: row.client_id, name: row.name ?? null });
    if (row.report_recipients) {
      recipients = recipients.concat(parseRecipientList(row.report_recipients));
    }
  }
  return { clients, recipients: dedupeRecipients(recipients) };
}

function formatWindowLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) {
    return 'Custom window';
  }
  if (hours % 24 === 0) {
    const days = hours / 24;
    if (days === 1) {
      return 'Last 24h';
    }
    return `Last ${days} days`;
  }
  const rounded = Math.round(hours * 10) / 10;
  return `Last ${rounded} hours`;
}

function keyToPath(key: string): string {
  return `/${key}`;
}

function normalizeReportPath(path: string): string | null {
  if (!path) return null;
  let value = path.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    value = parsed.pathname || value;
  } catch {}
  if (value.startsWith('/api/reports/')) {
    return value;
  }
  if (value.startsWith('api/reports/')) {
    return `/${value}`;
  }
  value = value.replace(/^\/+/, '');
  if (!value) {
    return null;
  }
  return `/api/reports/${value}`;
}

function parseDateParam(value?: string | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return date;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date.valueOf());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function listArchiveRows(DB: D1Database, day: Date): Promise<AdminArchiveRow[]> {
  const start = startOfUtcDay(day);
  const end = addUtcDays(start, 1);
  try {
    const res = await DB.prepare(
      `SELECT table_name, row_count, object_key, size_bytes, exported_at
         FROM export_log
        WHERE exported_at >= ? AND exported_at < ?
        ORDER BY exported_at DESC`,
    )
      .bind(start.toISOString(), end.toISOString())
      .all<{
        table_name: string | null;
        row_count: number | null;
        object_key: string | null;
        size_bytes: number | null;
        exported_at: string | null;
      }>();
    return (res.results ?? []).map((row) => ({
      table: row.table_name ?? '—',
      rows: Math.max(0, Number(row.row_count ?? 0)),
      key: row.object_key ?? '',
      size: Math.max(0, Number(row.size_bytes ?? 0)),
      exportedAt: row.exported_at ?? null,
    }));
  } catch (error) {
    console.warn('listArchiveRows failed', error);
    return [];
  }
}

async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : input;
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function formatCsvValue(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  const escaped = str.replace(/"/g, '""');
  return /[",\r\n]/.test(str) ? `"${escaped}"` : escaped;
}

function ndjsonToCsvStream(
  stream: ReadableStream<Uint8Array>,
  columns?: string[],
): ReadableStream<Uint8Array> {
  const initialColumns = columns && columns.length > 0 ? [...columns] : undefined;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = '';
      let headerWritten = false;
      let cols = initialColumns;

      const writeHeader = () => {
        if (!headerWritten && cols && cols.length > 0) {
          controller.enqueue(encoder.encode(cols.join(',') + '\n'));
          headerWritten = true;
        }
      };

      const pushRow = (record: Record<string, unknown>) => {
        if (!cols || cols.length === 0) {
          cols = Object.keys(record);
        }
        if (!cols || cols.length === 0) {
          return;
        }
        writeHeader();
        const values = cols.map((key) => formatCsvValue(record[key]));
        controller.enqueue(encoder.encode(values.join(',') + '\n'));
      };

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') {
            pushRow(parsed as Record<string, unknown>);
          }
        } catch (error) {
          console.warn('ndjson parse failed', error);
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            processLine(line);
            newlineIndex = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        if (buffer.length > 0) {
          processLine(buffer.replace(/\r$/, ''));
        }
        writeHeader();
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

type BurnSnapshot = { total: number; ok: number; errRate: number; burn: number };
type FastBurnAction = 'opened' | 'closed' | 'none';
type FastBurnResult = { snapshot: BurnSnapshot; action: FastBurnAction };

function parseDurationMinutes(input: string | null | undefined): number | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = /^([0-9]+)([mh])$/i.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  if (unit === 'm') return value;
  if (unit === 'h') return value * 60;
  return null;
}

async function computeBurn(DB: D1Database, minutes = 10, target = 0.999): Promise<BurnSnapshot> {
  const row = await DB.prepare(
    `
    SELECT SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) ok,
           COUNT(*) total
    FROM ops_metrics
    WHERE route='/api/ingest' AND ts >= datetime('now', ?)
  `,
  )
    .bind(`-${minutes} minutes`)
    .first<{ ok: number; total: number }>();
  const total = row?.total ?? 0;
  const ok = row?.ok ?? 0;
  const errRate = total ? 1 - ok / total : 0;
  const burn = 1 - target > 0 ? errRate / (1 - target) : 0;
  return { total, ok, errRate, burn };
}

async function openP1IfNeeded(env: Env, nowISO: string, meta: BurnSnapshot): Promise<boolean> {
  const open = await env.DB.prepare(
    "SELECT alert_id FROM alerts WHERE type='ingest_degradation' AND state IN ('open','ack') ORDER BY opened_at DESC LIMIT 1",
  ).first<{ alert_id: string }>();
  if (open) return false;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO alerts (alert_id, device_id, type, severity, state, opened_at, meta_json) VALUES (?, NULL, 'ingest_degradation', 'critical', 'open', ?, ?)",
  )
    .bind(id, nowISO, JSON.stringify(meta))
    .run();
  await notifyOps(
    env,
    `P1: Ingest degradation — burn=${meta.burn.toFixed(2)} (err ${(meta.errRate * 100).toFixed(2)}%, ${meta.ok}/${meta.total} ok)`,
  );
  return true;
}

async function closeP1IfRecovered(env: Env, nowISO: string, meta: BurnSnapshot): Promise<boolean> {
  const open = await env.DB.prepare(
    "SELECT alert_id FROM alerts WHERE type='ingest_degradation' AND state IN ('open','ack') ORDER BY opened_at DESC LIMIT 1",
  ).first<{ alert_id: string }>();
  if (!open) return false;
  await env.DB.prepare("UPDATE alerts SET state='closed', closed_at=? WHERE alert_id=?")
    .bind(nowISO, open.alert_id)
    .run();
  await notifyOps(
    env,
    `Recovered: Ingest degradation — burn=${meta.burn.toFixed(2)} (err ${(meta.errRate * 100).toFixed(2)}%)`,
  );
  return true;
}

async function fastBurnMonitor(env: Env): Promise<FastBurnResult> {
  const nowISO = new Date().toISOString();
  const snapshot = await computeBurn(env.DB, 10, 0.999);
  let action: FastBurnAction = 'none';
  if (snapshot.total >= 200 && snapshot.burn > 2.0) {
    if (await openP1IfNeeded(env, nowISO, snapshot)) {
      action = 'opened';
    }
  }
  if (snapshot.total >= 200 && snapshot.burn <= 1.0) {
    if (await closeP1IfRecovered(env, nowISO, snapshot)) {
      action = 'closed';
    }
  }
  return { snapshot, action };
}

async function pruneStaged(env: Env, days = 14) {
  const bucket: any = (env as any).ARCHIVE || (env as any).REPORTS;
  if (!bucket?.list) return;
  const cutoff = new Date(Date.now() - days * 86400000);

  let cursor: string | undefined;
  do {
    const res: any = await bucket.list({ prefix: 'staged/', cursor });
    cursor = res.truncated ? res.cursor : undefined;
    for (const o of res.objects || []) {
      const m = /^staged\/(\d{4}-\d{2}-\d{2})\//.exec(o.key);
      const d = m ? new Date(`${m[1]}T00:00:00Z`) : o.uploaded ? new Date(o.uploaded) : null;
      if (d && d < cutoff) {
        try {
          await bucket.delete(o.key);
        } catch {}
      }
    }
  } while (cursor);
}

async function isReadOnly(DB: D1Database) {
  return (await getSetting(DB, 'read_only')) === '1';
}

async function guardWrite(c: any) {
  if (await isReadOnly(c.env.DB)) {
    return c.text('Read-only mode active', 503);
  }
  return null;
}

type DeviceCommandBody = { dhwSetC?: number; mode?: string };

async function dispatchDeviceCommand(
  c: Context<Ctx>,
  deviceId: string,
  actor: string,
  commandBody: DeviceCommandBody,
): Promise<Response> {
  const envelope = {
    deviceId,
    actor,
    command: commandBody,
    limits: {
      minC: Number(c.env.WRITE_MIN_C ?? '40'),
      maxC: Number(c.env.WRITE_MAX_C ?? '60'),
    },
  };
  const payload = JSON.stringify(envelope);

  const doId = c.env.DEVICE_DO.idFromName(deviceId);
  const auditStub = c.env.DEVICE_DO.get(doId);
  const auditRes = await auditStub.fetch(
    new Request(`https://do/devices/${deviceId}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-operator-subject': actor,
      },
      body: payload,
    }),
  );

  if (!auditRes.ok) {
    return new Response(auditRes.body, { status: auditRes.status, headers: auditRes.headers });
  }

  const stateId = c.env.DeviceState.idFromName(deviceId);
  const stateStub = c.env.DeviceState.get(stateId);
  const res = await stateStub.fetch('https://do/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });

  return new Response(res.body, { status: res.status, headers: res.headers });
}

type Ctx = { Bindings: Env; Variables: { auth?: AccessContext } };

const app = new Hono<Ctx>();

app.use('*', cors());

app.get('/brand.css', (c) =>
  c.text(brandCss, 200, {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'public, max-age=300, s-maxage=3600',
    'CDN-Cache-Control': 'public, max-age=300, s-maxage=3600',
  }),
);

app.get('/brand/logo.svg', async (c) => {
  const baseHeaders = new Headers({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    'CDN-Cache-Control': 'public, max-age=86400, s-maxage=604800',
  });

  try {
    const logo = await c.env.BRAND.get('logo.svg');
    if (logo) {
      const headers = new Headers(baseHeaders);
      logo.writeHttpMetadata(headers);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'image/svg+xml; charset=utf-8');
      }
      return new Response(logo.body, { headers });
    }
  } catch (error) {
    console.warn('Failed to load brand logo from R2', error);
  }

  return new Response(brandLogoSvg, { headers: baseHeaders });
});

app.get('/brand/logo-mono.svg', async (c) => {
  const baseHeaders = new Headers({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    'CDN-Cache-Control': 'public, max-age=86400, s-maxage=604800',
  });

  try {
    const logo = await c.env.BRAND.get('logo-mono.svg');
    if (logo) {
      const headers = new Headers(baseHeaders);
      logo.writeHttpMetadata(headers);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'image/svg+xml; charset=utf-8');
      }
      return new Response(logo.body, { headers });
    }
  } catch (error) {
    console.warn('Failed to load monochrome brand logo from R2', error);
  }

  return new Response(brandLogoMonoSvg, { headers: baseHeaders });
});

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
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const deviceId = c.req.param('id');
  const body = await c.req.json<DeviceCommandBody>();
  const actor = auth.email ?? auth.sub ?? 'operator';

  return dispatchDeviceCommand(c, deviceId, actor, body);
});

app.post('/api/devices/:id/command', async (c) => {
  const ro = await isReadOnly(c.env.DB);
  if (ro) {
    return c.text('Read-only', 503);
  }

  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const deviceId = c.req.param('id');
  const raw = await c.req.text();
  let commandBody: DeviceCommandBody = {};
  if (raw.trim().length > 0) {
    try {
      commandBody = JSON.parse(raw) as DeviceCommandBody;
    } catch {
      return c.text('Invalid JSON body', 400);
    }
  }

  const actor = auth.email ?? auth.sub ?? 'operator';

  return dispatchDeviceCommand(c, deviceId, actor, commandBody);
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
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
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
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
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

app.get('/api/settings/public', async (c) => c.json({ read_only: await isReadOnly(c.env.DB) }));

app.get('/api/admin/settings', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare('SELECT key,value FROM settings').all<{ key: string; value: string }>();
  return c.json(rows.results ?? []);
});

app.post('/api/admin/settings', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const { key, value } = await c.req.json<{ key: string; value: string }>().catch(() => ({ key: '', value: '' }));
  if (!key) {
    return c.text('Bad Request', 400);
  }
  await setSetting(c.env.DB, key, value ?? '');
  return c.json({ ok: true });
});

app.get('/api/admin/presets', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const tables = ['telemetry', 'alerts', 'incidents'] as const;
  const result: Record<string, any[]> = {};
  for (const table of tables) {
    const raw = await getSetting(c.env.DB, `export_presets_${table}`);
    try {
      result[table] = raw ? JSON.parse(raw) : [];
    } catch {
      result[table] = [];
    }
  }
  return c.json(result);
});

app.post('/api/admin/presets', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const { table, presets } = await c.req.json().catch(() => ({}));
  if (!['telemetry', 'alerts', 'incidents'].includes(String(table))) {
    return c.text('Bad Request', 400);
  }
  const err = validatePresets(presets);
  if (err) {
    return c.json({ ok: false, error: err }, 400);
  }
  await setSetting(c.env.DB, `export_presets_${table}`, JSON.stringify(presets));
  return c.json({ ok: true });
});

app.get('/api/admin/archive', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const dateParam = url.searchParams.get('date');
  const parsed = parseDateParam(dateParam);
  const fallback = addUtcDays(startOfUtcDay(new Date()), -1);
  const target = parsed ?? fallback;
  const rows = await listArchiveRows(c.env.DB, target);
  return c.json({ date: formatDateKey(target), results: rows });
});

app.get('/api/admin/archive/download', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  const auth = jwt ? await verifyAccessJWT(c.env, jwt).catch(() => null) : null;
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const key = c.req.query('key');
  if (!key) {
    return c.text('Bad Request', 400);
  }
  const fmt = (c.req.query('format') || 'ndjson').toLowerCase();
  const cols = c
    .req
    .query('columns')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const gz = c.req.query('gz') === '1' || c.req.query('gzip') === '1';
  const gzl = Math.max(1, Math.min(9, Number(c.req.query('gzl') || 0) || 0));
  const stage = c.req.query('stage') === '1';

  const bucket: any = (c.env as any).ARCHIVE || (c.env as any).REPORTS;
  const src = await bucket.get(key);
  if (!src) {
    return c.text('Not Found', 404);
  }

  const base = (key.split('/').pop() || 'export').replace(/\.ndjson$/, '');

  const withGzip = (stream: ReadableStream<Uint8Array>) => {
    if (!gz) return stream;
    try {
      return stream.pipeThrough(new (globalThis as any).CompressionStream('gzip', { level: gzl || 6 }));
    } catch (error) {
      try {
        return stream.pipeThrough(new (globalThis as any).CompressionStream('gzip'));
      } catch (fallbackError) {
        console.warn('gzip unavailable', error, fallbackError);
        return stream;
      }
    }
  };

  if (stage) {
    const sig = await sha256Hex(JSON.stringify({ key, fmt, cols, gz, gzl }));
    const stamp = new Date().toISOString().slice(0, 10);
    const stagedKey = `staged/${stamp}/${base}-${sig}.${fmt}${gz ? '.gz' : ''}`;
    if (!(await bucket.head?.(stagedKey))) {
      const body = withGzip(
        fmt === 'csv'
          ? ndjsonToCsvStream(src.body as ReadableStream<Uint8Array>, cols?.length ? cols : undefined)
          : (src.body as ReadableStream<Uint8Array>),
      );
      await bucket.put(stagedKey, body, {
        httpMetadata: { contentType: fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson' },
      });
    }
    return c.redirect(`/api/admin/archive/object?key=${encodeURIComponent(stagedKey)}`, 302);
  }

  if (fmt === 'csv') {
    const s = ndjsonToCsvStream(src.body as ReadableStream<Uint8Array>, cols?.length ? cols : undefined);
    return new Response(withGzip(s), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.csv${gz ? '.gz' : ''}"`,
        'Cache-Control': 'no-store',
        ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
      },
    });
  }

  return new Response(withGzip(src.body as ReadableStream<Uint8Array>), {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="${base}.ndjson${gz ? '.gz' : ''}"`,
      'Cache-Control': 'no-store',
      ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
    },
  });
});

app.get('/api/admin/archive/staged-for', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const date = c.req.query('date');
  const base = c.req.query('base');
  if (!date || !base) {
    return c.text('Bad Request', 400);
  }

  const bucket: any = (c.env as any).ARCHIVE || (c.env as any).REPORTS;
  if (!bucket?.list) {
    return c.json({});
  }
  let latest: any = null;

  try {
    const prefix = `staged/${date}/${base}-`;
    const res = await bucket.list({ prefix });
    for (const o of res.objects || []) {
      const m = /-p-([A-Za-z0-9_-]+)-/.exec(o.key);
      const preset = m ? m[1] : o.customMetadata?.preset || null;
      if (!latest || (o.uploaded && latest.uploaded && o.uploaded > latest.uploaded)) {
        latest = { key: o.key, preset, size: o.size, uploaded: o.uploaded };
      }
    }
  } catch (error) {
    console.warn('staged-for lookup failed', error);
  }

  return c.json(latest || {});
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
  const started = Date.now();
  let status = 500;
  let deviceId: string | undefined;
  try {
    const body = await c.req.json<IngestBody>().catch(() => null);
    if (!body?.deviceId || !body?.ts) {
      status = 400;
      return c.text('Bad Request', 400);
    }

    deviceId = body.deviceId;
    const ok = await verifyDeviceKey(c.env.DB, body.deviceId, c.req.header('X-GREENBRO-DEVICE-KEY'));
    if (!ok) {
      status = 403;
      return c.text('Forbidden', 403);
    }

    const profileId = c.req.param('profileId');
    const idemKey =
      body.idempotencyKey ??
      (await (async () => {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
        return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
      })());

    if (await isDuplicate(c.env.DB, idemKey)) {
      status = 200;
      return c.json({ ok: true, deduped: true });
    }

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

    await c.env.INGEST_Q.send({ type: 'telemetry', profileId, body: telemetry });

    if (body.heartbeat) {
      const rssi = toNumber(body.heartbeat.rssi);
      await c.env.INGEST_Q.send({
        type: 'heartbeat',
        profileId,
        body: { deviceId: body.deviceId, ts: body.ts, rssi },
      });
    }

    status = 200;
    return c.json({ ok: true, queued: true });
  } catch (error) {
    console.error('Failed to ingest telemetry', error);
    status = 500;
    return c.text('Internal Server Error', 500);
  } finally {
    const duration = Date.now() - started;
    await logOpsMetric(c.env.DB, '/api/ingest', status, duration, deviceId);
  }
});

app.post('/api/ops/recompute-baselines', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await recomputeBaselines(c.env.DB);
  return c.json({ ok: true });
});

app.post('/api/ops/incidents/sweep', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const hoursParam = url.searchParams.get('hours');
  const hours = Number(hoursParam ?? '48');
  const windowHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 240) : 48;
  const result = await sweepIncidents(c.env.DB, windowHours);
  return c.json({ ok: true, windowHours, ...result });
});

app.get('/api/ops/incidents', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const sinceParam = url.searchParams.get('since');
  const siteId = url.searchParams.get('siteId');

  let sinceExpr = "datetime('now', ?)";
  const bind: string[] = [];

  if (sinceParam && /^\d{4}-\d{2}-\d{2}/.test(sinceParam)) {
    sinceExpr = '?';
    bind.push(sinceParam);
  } else {
    bind.push(sinceParam ?? '-72 hours');
  }

  let siteClause = '';
  if (siteId) {
    siteClause = ' AND i.site_id = ?';
    bind.push(siteId);
  }

  const rows = await c.env.DB.prepare(
    `SELECT i.incident_id, i.site_id, i.started_at, i.last_alert_at, i.resolved_at, s.name AS site_name
       FROM incidents i
       LEFT JOIN sites s ON s.site_id = i.site_id
      WHERE i.started_at >= ${sinceExpr}${siteClause}
      ORDER BY i.started_at DESC
      LIMIT 200`,
  )
    .bind(...bind)
    .all<{
      incident_id: string;
      site_id: string;
      started_at: string;
      last_alert_at: string;
      resolved_at: string | null;
      site_name: string | null;
    }>();

  const incidents = rows.results ?? [];
  if (incidents.length === 0) {
    return c.json([]);
  }

  const ids = incidents.map((r) => r.incident_id);
  const placeholders = ids.map(() => '?').join(',');
  const alertRows = await c.env.DB.prepare(
    `SELECT ia.incident_id, a.type, a.severity, a.state, COUNT(*) as count
       FROM incident_alerts ia
       JOIN alerts a ON a.alert_id = ia.alert_id
      WHERE ia.incident_id IN (${placeholders})
      GROUP BY ia.incident_id, a.type, a.severity, a.state`,
  )
    .bind(...ids)
    .all<{ incident_id: string; type: string; severity: string; state: string; count: number }>();

  const grouped = new Map<
    string,
    {
      states: Record<string, number>;
      types: Map<string, { type: string; severity: string; count: number }>;
    }
  >();

  for (const row of alertRows.results ?? []) {
    if (!grouped.has(row.incident_id)) {
      grouped.set(row.incident_id, { states: {}, types: new Map() });
    }
    const bucket = grouped.get(row.incident_id)!;
    bucket.states[row.state] = (bucket.states[row.state] ?? 0) + row.count;
    const key = `${row.type}::${row.severity}`;
    const prev = bucket.types.get(key);
    if (prev) {
      prev.count += row.count;
    } else {
      bucket.types.set(key, { type: row.type, severity: row.severity, count: row.count });
    }
  }

  const out = incidents.map((incident) => {
    const meta = grouped.get(incident.incident_id);
    const states = meta?.states ?? {};
    const total = Object.values(states).reduce((acc, value) => acc + value, 0);
    return {
      incidentId: incident.incident_id,
      siteId: incident.site_id,
      siteName: incident.site_name ?? null,
      startedAt: incident.started_at,
      lastAlertAt: incident.last_alert_at,
      resolvedAt: incident.resolved_at,
      alerts: {
        total,
        open: states.open ?? 0,
        ack: states.ack ?? 0,
        closed: states.closed ?? 0,
      },
      types: meta ? Array.from(meta.types.values()) : [],
    };
  });

  return c.json(out);
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
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
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
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
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
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
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
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
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
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
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

app.get('/api/admin/slo', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('clientId');
  let sql =
    'SELECT cs.client_id, cs.uptime_target, cs.ingest_target, cs.cop_target, cs.report_recipients, cs.updated_at, c.name AS client_name FROM client_slos cs LEFT JOIN clients c ON c.client_id = cs.client_id';
  const bind: string[] = [];
  if (clientId) {
    sql += ' WHERE cs.client_id = ?';
    bind.push(clientId);
  }
  sql += ' ORDER BY COALESCE(c.name, cs.client_id)';
  const rows = await c.env.DB.prepare(sql).bind(...bind).all();
  return c.json(rows.results ?? []);
});

app.post('/api/admin/slo', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const body = await c.req
    .json<{
      clientId: string;
      uptimeTarget?: number | string | null;
      ingestTarget?: number | string | null;
      copTarget?: number | string | null;
      reportRecipients?: string | null;
    }>()
    .catch(() => null);
  if (!body?.clientId) {
    return c.text('clientId required', 400);
  }

  const toRatio = (value: number | string | null | undefined): number | null => {
    if (value == null) return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  };

  const uptimeTarget = toRatio(body.uptimeTarget);
  const ingestTarget = toRatio(body.ingestTarget);
  const copTarget = toRatio(body.copTarget);
  const recipients = body.reportRecipients ?? null;

  await c.env.DB.prepare(
    `INSERT INTO client_slos (client_id, uptime_target, ingest_target, cop_target, report_recipients, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(client_id) DO UPDATE SET
         uptime_target=excluded.uptime_target,
         ingest_target=excluded.ingest_target,
         cop_target=excluded.cop_target,
         report_recipients=excluded.report_recipients,
         updated_at=excluded.updated_at`,
  )
    .bind(body.clientId, uptimeTarget, ingestTarget, copTarget, recipients)
    .run();

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

app.get('/api/admin/maintenance', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare(
    `SELECT id, site_id, device_id, start_ts, end_ts, reason,
            CASE WHEN start_ts <= datetime('now') AND (end_ts IS NULL OR end_ts >= datetime('now')) THEN 1 ELSE 0 END AS active
       FROM maintenance_windows
       ORDER BY start_ts DESC
       LIMIT 200`,
  ).all<{
    id: string;
    site_id: string | null;
    device_id: string | null;
    start_ts: string;
    end_ts: string;
    reason: string | null;
    active: number | null;
  }>();
  const results = (rows.results ?? []).map((row) => ({
    ...row,
    active: row.active === 1,
  }));
  return c.json(results);
});

app.post('/api/admin/maintenance', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const body = await c.req
    .json<{ siteId?: string; deviceId?: string; startTs?: string; endTs?: string; reason?: string }>()
    .catch(() => null);
  if (!body) {
    return c.text('Bad Request', 400);
  }

  const siteId = body.siteId?.trim() || null;
  const deviceId = body.deviceId?.trim() || null;
  if (!siteId && !deviceId) {
    return c.text('Must provide a siteId or deviceId', 400);
  }

  const startTs = parseIsoTimestamp(body.startTs);
  const endTs = parseIsoTimestamp(body.endTs);
  if (!startTs || !endTs) {
    return c.text('Invalid start or end timestamp', 400);
  }

  if (Date.parse(startTs) >= Date.parse(endTs)) {
    return c.text('End must be after start', 400);
  }

  const reason = body.reason?.trim();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO maintenance_windows (id, site_id, device_id, start_ts, end_ts, reason) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, siteId, deviceId, startTs, endTs, reason && reason.length > 0 ? reason.slice(0, 500) : null)
    .run();

  return c.json({ ok: true, id });
});

app.delete('/api/admin/maintenance/:id', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM maintenance_windows WHERE id=?').bind(id).run();
  return c.json({ ok: true });
});

app.post('/api/admin/sites', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
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
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
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

app.get('/api/regions', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);

  const rows = await c.env.DB.prepare(
    `
    SELECT COALESCE(region, '—') AS region, COUNT(*) AS sites
      FROM sites
     GROUP BY region
     ORDER BY region
  `,
  ).all<{ region: string; sites: number }>();

  return c.json({ regions: rows.results ?? [] });
});

app.get('/api/site-list', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);

  const region = c.req.query('region');
  const qParam = c.req.query('q');
  const limitParam = Number(c.req.query('limit') ?? 2000);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.floor(limitParam), 1), 5000)
    : 2000;
  const searchTerm = typeof qParam === 'string' ? qParam.trim() : '';

  let sql = 'SELECT site_id, name, region FROM sites WHERE site_id IS NOT NULL';
  const bind: Array<string | number> = [];
  if (region) {
    sql += ' AND region = ?';
    bind.push(region);
  }
  if (searchTerm) {
    const pattern = `%${escapeForLike(searchTerm)}%`;
    sql += " AND (site_id LIKE ? ESCAPE '\\\\' OR name LIKE ? ESCAPE '\\\\')";
    bind.push(pattern, pattern);
  }

  sql += ' ORDER BY (name IS NULL), name, site_id LIMIT ?';
  bind.push(limit);

  const rows = await c.env.DB.prepare(sql)
    .bind(...bind)
    .all<{ site_id: string; name: string | null; region: string | null }>();

  return c.json({ sites: rows.results ?? [] });
});

app.get('/api/sites/search', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const region = c.req.query('region');
  const onlyUnhealthyParam = c.req.query('only_unhealthy');
  const limitParam = Number(c.req.query('limit') ?? 100);
  const offsetParam = Number(c.req.query('offset') ?? 0);
  const limit = Number.isFinite(limitParam) ? Math.min(500, Math.max(1, limitParam)) : 100;
  const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;
  const onlyUnhealthy =
    typeof onlyUnhealthyParam === 'string'
      ? ['1', 'true', 'yes', 'on'].includes(onlyUnhealthyParam.toLowerCase())
      : false;
  const staleMinutesThreshold = 10;

  const siteSearchCte = `WITH all_sites AS (
      SELECT site_id FROM sites WHERE site_id IS NOT NULL
      UNION
      SELECT DISTINCT site_id FROM devices WHERE site_id IS NOT NULL
      UNION
      SELECT DISTINCT site_id FROM site_clients WHERE site_id IS NOT NULL
    ),
    device_stats AS (
      SELECT site_id,
             COUNT(*) AS total_devices,
             SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) AS online_devices,
             MIN(CASE WHEN last_seen_at IS NULL THEN NULL ELSE ROUND((julianday('now') - julianday(last_seen_at)) * 24 * 60) END) AS freshness_min
      FROM devices
      GROUP BY site_id
    ),
    alert_stats AS (
      SELECT d.site_id AS site_id,
             COUNT(*) AS open_alerts
        FROM alerts a
        JOIN devices d ON d.device_id = a.device_id
       WHERE a.state IN ('open','ack')
       GROUP BY d.site_id
    ),
    base AS (
      SELECT a.site_id,
             s.name,
             s.region,
             s.lat,
             s.lon,
             COALESCE(device_stats.total_devices, 0) AS total_devices,
             COALESCE(device_stats.online_devices, 0) AS online_devices,
             device_stats.freshness_min,
             COALESCE(alert_stats.open_alerts, 0) AS open_alerts
        FROM all_sites a
        LEFT JOIN sites s ON s.site_id = a.site_id
        LEFT JOIN device_stats ON device_stats.site_id = a.site_id
        LEFT JOIN alert_stats ON alert_stats.site_id = a.site_id
    ),
    annotated AS (
      SELECT base.*,
             (base.total_devices - base.online_devices) AS offline_devices,
             CASE
               WHEN base.total_devices = 0 THEN 0
               WHEN base.open_alerts > 0 OR (base.total_devices - base.online_devices) > 0 OR (base.freshness_min IS NOT NULL AND base.freshness_min > ?) THEN 1
               ELSE 0
             END AS is_unhealthy
        FROM base
    )`;

  const page = await c.env.DB.prepare(
    `${siteSearchCte}
    SELECT site_id, name, region, lat, lon, total_devices, online_devices, offline_devices, open_alerts, freshness_min, is_unhealthy
      FROM annotated
     WHERE (? IS NULL OR region = ?)
       AND (? = 0 OR is_unhealthy = 1)
     ORDER BY site_id
     LIMIT ? OFFSET ?`,
  )
    .bind(
      staleMinutesThreshold,
      region ?? null,
      region ?? null,
      onlyUnhealthy ? 1 : 0,
      limit,
      offset,
    )
    .all<{
      site_id: string | null;
      name: string | null;
      region: string | null;
      lat: number | null;
      lon: number | null;
      total_devices: number | null;
      online_devices: number | null;
      offline_devices: number | null;
      open_alerts: number | null;
      freshness_min: number | null;
      is_unhealthy: number | null;
    }>();

  const totalRow = await c.env.DB.prepare(
    `${siteSearchCte}
    SELECT COUNT(*) AS n
      FROM annotated
     WHERE (? IS NULL OR region = ?)
       AND (? = 0 OR is_unhealthy = 1)`,
  )
    .bind(staleMinutesThreshold, region ?? null, region ?? null, onlyUnhealthy ? 1 : 0)
    .first<{ n: number }>();

  const total = toNumber(totalRow?.n) ?? 0;
  const results = (page.results ?? []).map((row) => {
    const totalDevices = toNumber(row.total_devices) ?? 0;
    const onlineDevices = toNumber(row.online_devices) ?? 0;
    const offlineDevices = toNumber(row.offline_devices) ?? 0;
    const openAlerts = toNumber(row.open_alerts) ?? 0;
    const freshnessMin = toNumber(row.freshness_min);
    const unhealthy = row.is_unhealthy === 1;
    let health: 'healthy' | 'unhealthy' | 'empty';
    if (totalDevices === 0) {
      health = 'empty';
    } else {
      health = unhealthy ? 'unhealthy' : 'healthy';
    }
    return {
      site_id: row.site_id,
      name: row.name,
      region: row.region,
      lat: toNumber(row.lat),
      lon: toNumber(row.lon),
      total_devices: totalDevices,
      online_devices: onlineDevices,
      offline_devices: offlineDevices,
      open_alerts: openAlerts,
      freshness_min: freshnessMin,
      health,
    };
  });

  return c.json({ results, total, limit, offset, has_more: offset + limit < total });
});

app.get('/api/devices/search', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const site = c.req.query('site_id');
  const region = c.req.query('region');
  const health = c.req.query('health');
  const limitParam = Number(c.req.query('limit') ?? 100);
  const offsetParam = Number(c.req.query('offset') ?? 0);
  const limit = Number.isFinite(limitParam) ? Math.min(500, Math.max(1, limitParam)) : 100;
  const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;

  const where = `WHERE ( ? IS NULL OR d.site_id = ? )
                 AND ( ? IS NULL OR s.region = ? )`;
  const rows = await c.env.DB.prepare(
    `SELECT d.device_id, d.site_id, s.region AS region, d.firmware, d.model, d.online, d.last_seen_at,
            COALESCE(SUM(CASE WHEN a.state IN ('open','ack') THEN 1 ELSE 0 END),0) AS open_alerts
       FROM devices d
       LEFT JOIN sites s ON s.site_id=d.site_id
       LEFT JOIN alerts a ON a.device_id=d.device_id AND a.state IN ('open','ack')
       ${where}
       GROUP BY d.device_id
       HAVING (? IS NULL) OR (
         (?='online'    AND d.online=1) OR
         (?='offline'   AND d.online=0) OR
         (?='unhealthy' AND (d.online=0 OR open_alerts>0))
       )
       ORDER BY d.site_id, d.device_id
       LIMIT ? OFFSET ?`,
  )
    .bind(
      site ?? null,
      site ?? null,
      region ?? null,
      region ?? null,
      health ?? null,
      health ?? null,
      health ?? null,
      health ?? null,
      limit,
      offset,
    )
    .all<{
      device_id: string;
      site_id: string | null;
      firmware: string | null;
      model: string | null;
      online: number | null;
      last_seen_at: string | null;
      region: string | null;
      open_alerts: number | null;
    }>();

  const totalRow = await c.env.DB.prepare(
    `WITH base AS (
        SELECT d.device_id, d.online, d.site_id, s.region AS region,
               COALESCE(SUM(CASE WHEN a.state IN ('open','ack') THEN 1 ELSE 0 END),0) AS open_alerts
          FROM devices d
          LEFT JOIN sites s ON s.site_id=d.site_id
          LEFT JOIN alerts a ON a.device_id=d.device_id AND a.state IN ('open','ack')
          ${where}
          GROUP BY d.device_id
      )
      SELECT COUNT(*) AS n FROM base
      WHERE (? IS NULL) OR (
        (?='online'    AND online=1) OR
        (?='offline'   AND online=0) OR
        (?='unhealthy' AND (online=0 OR open_alerts>0))
      )`,
  )
    .bind(
      site ?? null,
      site ?? null,
      region ?? null,
      region ?? null,
      health ?? null,
      health ?? null,
      health ?? null,
      health ?? null,
    )
    .first<{ n: number }>();

  const total = toNumber(totalRow?.n) ?? 0;
  const results = (rows.results ?? []).map((row) => {
    const openAlerts = toNumber(row.open_alerts) ?? 0;
    const isOnline = row.online === 1;
    const derivedHealth = !isOnline || openAlerts > 0 ? 'unhealthy' : 'healthy';
    return {
      device_id: row.device_id,
      site_id: row.site_id,
      firmware: row.firmware,
      model: row.model,
      online: isOnline,
      last_seen_at: row.last_seen_at,
      region: row.region,
      open_alerts: openAlerts,
      health: derivedHealth,
    };
  });

  return c.json({ results, total, limit, offset, has_more: offset + limit < total });
});

app.post('/api/commissioning/:deviceId/report', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
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

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  const latestP1 = await c.env.DB.prepare(
    `SELECT opened_at, closed_at, state
       FROM alerts
       WHERE type='ingest_degradation'
       ORDER BY opened_at DESC
       LIMIT 1`,
  ).first<{ opened_at: string; closed_at: string | null; state: string }>();

  const maintenance = await c.env.DB.prepare(
    `SELECT site_id, device_id, start_ts, end_ts, reason
       FROM maintenance_windows
       WHERE (site_id = ? OR site_id IS NULL)
         AND (device_id IS NULL OR device_id IN (SELECT device_id FROM devices WHERE site_id=?))
         AND end_ts >= ?
         AND start_ts <= ?
       ORDER BY start_ts DESC
       LIMIT 5`,
  )
    .bind(siteId, siteId, windowStartIso, windowEndIso)
    .all<{
      site_id: string | null;
      device_id: string | null;
      start_ts: string;
      end_ts: string | null;
      reason: string | null;
    }>();

  const pdf = await PDFDocument.create();
  let page = pdf.addPage([595, 842]);
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

  const normalizeIso = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf())) return null;
    return parsed.toISOString();
  };

  if (y < 140) {
    page = pdf.addPage([595, 842]);
    y = 780;
  }

  y -= 6;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
  y -= 12;

  draw('Context timeline:', 14);

  if (latestP1) {
    const opened = normalizeIso(latestP1.opened_at) ?? latestP1.opened_at;
    const closed = normalizeIso(latestP1.closed_at) ?? (latestP1.closed_at ? latestP1.closed_at : 'ongoing');
    draw(`P1 ingest degradation: ${opened} → ${closed} (${latestP1.state})`);
  } else {
    draw('P1 ingest degradation: none recorded.');
  }

  const maintenanceRows = maintenance.results ?? [];
  if (maintenanceRows.length === 0) {
    draw('Maintenance windows: none overlapping reporting window.');
  } else {
    draw('Maintenance windows impacting window:');
    for (const row of maintenanceRows) {
      if (y < 60) {
        page = pdf.addPage([595, 842]);
        y = 780;
      }
      const scope = row.device_id
        ? `Device ${row.device_id}`
        : row.site_id
          ? `Site ${row.site_id}`
          : 'Global';
      const startIso = normalizeIso(row.start_ts) ?? row.start_ts;
      const endIso = normalizeIso(row.end_ts) ?? (row.end_ts ? row.end_ts : 'open');
      const reason = row.reason ? ` — ${row.reason.slice(0, 80)}` : '';
      draw(`• ${scope}: ${startIso} → ${endIso}${reason}`);
    }
  }

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

app.post('/api/reports/incident/v2', async (c) => {
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

  const hoursRaw = Number(hoursParam ?? '24');
  const windowHours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 24;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  const site = await c.env.DB.prepare('SELECT site_id, name, region FROM sites WHERE site_id=?')
    .bind(siteId)
    .first<{ site_id: string; name: string | null; region: string | null }>();

  const severityRows = await c.env.DB.prepare(
    `SELECT severity, COUNT(*) as n
       FROM alerts
      WHERE device_id IN (SELECT device_id FROM devices WHERE site_id=?)
        AND state IN ('open','ack')
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

  const incidentsRows = await c.env.DB.prepare(
    `SELECT incident_id, site_id, started_at, last_alert_at, resolved_at
       FROM incidents
      WHERE site_id=?
        AND started_at <= ?
        AND (resolved_at IS NULL OR resolved_at >= ?)
      ORDER BY started_at DESC
      LIMIT 50`,
  )
    .bind(siteId, windowEndIso, windowStartIso)
    .all<{
      incident_id: string;
      site_id: string;
      started_at: string;
      last_alert_at: string | null;
      resolved_at: string | null;
    }>();

  const incidents = incidentsRows.results ?? [];
  let incidentMeta = new Map<
    string,
    {
      states: Record<string, number>;
      alerts: Map<string, { type: string; severity: string; count: number }>;
    }
  >();

  if (incidents.length > 0) {
    const ids = incidents.map((row) => row.incident_id);
    const placeholders = ids.map(() => '?').join(',');
    const metaRows = await c.env.DB.prepare(
      `SELECT ia.incident_id, a.type, a.severity, a.state, COUNT(*) as count
         FROM incident_alerts ia
         JOIN alerts a ON a.alert_id = ia.alert_id
        WHERE ia.incident_id IN (${placeholders})
        GROUP BY ia.incident_id, a.type, a.severity, a.state`,
    )
      .bind(...ids)
      .all<{ incident_id: string; type: string; severity: string; state: string | null; count: number }>();

    incidentMeta = new Map();
    for (const row of metaRows.results ?? []) {
      if (!incidentMeta.has(row.incident_id)) {
        incidentMeta.set(row.incident_id, { states: {}, alerts: new Map() });
      }
      const bucket = incidentMeta.get(row.incident_id)!;
      if (row.state) {
        bucket.states[row.state] = (bucket.states[row.state] ?? 0) + row.count;
      }
      const key = `${row.type}:${row.severity}`;
      if (!bucket.alerts.has(key)) {
        bucket.alerts.set(key, { type: row.type, severity: row.severity, count: row.count });
      } else {
        const existing = bucket.alerts.get(key)!;
        existing.count += row.count;
      }
    }
  }

  const maintenanceRows = await c.env.DB.prepare(
    `SELECT site_id, device_id, start_ts, end_ts, reason
       FROM maintenance_windows
      WHERE (site_id = ? OR site_id IS NULL)
        AND (device_id IS NULL OR device_id IN (SELECT device_id FROM devices WHERE site_id=?))
        AND end_ts >= ?
        AND start_ts <= ?
      ORDER BY start_ts DESC
      LIMIT 20`,
  )
    .bind(siteId, siteId, windowStartIso, windowEndIso)
    .all<{
      site_id: string | null;
      device_id: string | null;
      start_ts: string;
      end_ts: string | null;
      reason: string | null;
    }>();

  const payload: IncidentReportV2Payload = {
    siteId,
    siteName: site?.name ?? null,
    region: site?.region ?? null,
    windowLabel: formatWindowLabel(windowHours),
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    generatedAt: new Date().toISOString(),
    summary: {
      severities: (severityRows.results ?? []).map((row) => ({ severity: row.severity, count: row.n })),
      topDevices: (top.results ?? []).map((row) => ({ deviceId: row.device_id, openCount: row.open_count ?? 0 })),
    },
    incidents: incidents.map((row) => {
      const bucket = incidentMeta.get(row.incident_id);
      const alertBreakdown = bucket
        ? Array.from(bucket.alerts.values()).sort((a, b) => b.count - a.count)
        : [];
      return {
        incidentId: row.incident_id,
        startedAt: row.started_at,
        lastAlertAt: row.last_alert_at ?? null,
        resolvedAt: row.resolved_at ?? null,
        stateCounts: bucket?.states ?? {},
        alertBreakdown,
      };
    }),
    maintenance: (maintenanceRows.results ?? []).map((row) => ({
      siteId: row.site_id,
      deviceId: row.device_id,
      startTs: row.start_ts,
      endTs: row.end_ts,
      reason: row.reason ?? null,
    })),
  };

  const pdf = await generateIncidentReportV2(c.env, payload);
  const path = keyToPath(pdf.key);

  const { clients, recipients } = await collectSiteRecipients(c.env.DB, siteId);
  const primaryClientId = clients.length > 0 ? clients[0].id : null;

  await logReportDelivery(c.env.DB, {
    type: 'incident',
    status: 'generated',
    clientId: primaryClientId,
    siteId,
    path,
    meta: { hours: windowHours, windowStart: payload.windowStart, windowEnd: payload.windowEnd },
  });

  let emailed = false;
  if (recipients.length > 0) {
    const emailSettings = await loadEmailSettings(c.env.DB);
    const subject = `Incident report — ${payload.siteName ?? payload.siteId}`;
    const introLines = [`Incident report for ${payload.siteName ?? payload.siteId}`];
    const detailLines = [
      `Window: ${payload.windowStart} → ${payload.windowEnd}`,
      payload.incidents.length === 0
        ? 'Incidents: none recorded in this window'
        : `Incidents: ${payload.incidents.length}`,
      payload.maintenance.length === 0
        ? 'Maintenance windows: none'
        : `Maintenance windows: ${payload.maintenance.length}`,
      `Download: ${pdf.url}`,
    ];
    const footerLines = [`R2 path: ${path}`];
    const html = brandEmail({
      title: 'Incident report ready',
      introLines,
      detailLines,
      footerLines,
      cta: { href: pdf.url, label: 'View report' },
    });
    const text = [...introLines, ...detailLines, ...footerLines].join('\n');
    emailed = await sendEmail(c.env, recipients, subject, text, emailSettings, html);
    // To capture email sends in the audit log, call logReportDelivery(c.env.DB, { ...status: 'sent' }) here.
  }

  return c.json({
    ok: true,
    key: pdf.key,
    path,
    url: pdf.url,
    window: { start: payload.windowStart, end: payload.windowEnd, hours: windowHours },
    incidents: payload.incidents.length,
    maintenance: payload.maintenance.length,
    emailed,
    recipients,
    clients,
  });
});

app.post('/api/reports/client-monthly', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('client_id');
  const monthParam = url.searchParams.get('month');
  if (!clientId || !monthParam) {
    return c.text('client_id and month required', 400);
  }

  let prepared;
  try {
    prepared = await buildClientMonthlyReportPayload(c.env, clientId, monthParam);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to prepare report';
    if (message === 'Client not found') {
      return c.text(message, 404);
    }
    return c.text(message, 400);
  }

  const { payload, client } = prepared;

  const pdf = await generateClientMonthlyReport(c.env, payload);

  await logReportDelivery(c.env.DB, {
    type: 'monthly',
    status: 'generated',
    clientId: client.id,
    siteId: null,
    path: keyToPath(pdf.key),
    subject: `Monthly report — ${payload.monthLabel} (${client.name})`,
    meta: { month: monthParam, version: 'v1' },
  });

  return c.json({
    ok: true,
    key: pdf.key,
    url: pdf.url,
    client,
    month: monthParam,
    metrics: payload.metrics,
    targets: payload.targets,
    siteCount: payload.siteCount,
    deviceCount: payload.deviceCount,
    recipients: payload.recipients,
  });
});

app.post('/api/reports/email-existing', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  let body: {
    type?: string;
    client_id?: string | null;
    site_id?: string | null;
    path?: string | null;
    subject?: string | null;
  } | null = null;
  try {
    body = await c.req.json();
  } catch {}

  const type = typeof body?.type === 'string' ? body.type.trim() : '';
  const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : '';
  const siteId = typeof body?.site_id === 'string' ? body.site_id.trim() : '';
  const subjectInput = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const normalizedType = type || 'monthly';
  if (!body?.path) {
    return c.text('path required', 400);
  }
  const normalizedPath = normalizeReportPath(body.path);
  if (!normalizedPath) {
    return c.text('Invalid path', 400);
  }
  if (normalizedType !== 'monthly' && normalizedType !== 'incident') {
    return c.text('Unsupported report type', 400);
  }
  if (!clientId && !siteId) {
    return c.text('client_id or site_id required', 400);
  }

  let resolvedClientId: string | null = clientId || null;
  let clientName: string | null = null;
  let siteName: string | null = null;
  let recipients: string[] = [];

  if (clientId) {
    const row = await c.env.DB.prepare(
      `SELECT c.client_id, COALESCE(c.name, c.client_id) AS name, cs.report_recipients
         FROM clients c
         LEFT JOIN client_slos cs ON cs.client_id = c.client_id
        WHERE c.client_id = ?`,
    )
      .bind(clientId)
      .first<{ client_id: string; name: string | null; report_recipients: string | null }>();
    if (row) {
      clientName = row.name ?? row.client_id;
      recipients = recipients.concat(parseRecipientList(row.report_recipients ?? null));
    }
  }

  if (siteId) {
    const siteRow = await c.env.DB.prepare('SELECT site_id, name FROM sites WHERE site_id=?')
      .bind(siteId)
      .first<{ site_id: string; name: string | null }>();
    if (siteRow) {
      siteName = siteRow.name ?? siteRow.site_id;
    }
    const { clients, recipients: siteRecipients } = await collectSiteRecipients(c.env.DB, siteId);
    recipients = recipients.concat(siteRecipients);
    if (!resolvedClientId && clients.length === 1) {
      resolvedClientId = clients[0].id;
      if (!clientName) {
        clientName = clients[0].name ?? clients[0].id;
      }
    }
  }

  const uniqueRecipients = dedupeRecipients(recipients);
  const defaultSubject = (() => {
    if (normalizedType === 'monthly') {
      return `Monthly report link — ${clientName ?? resolvedClientId ?? 'GreenBro'}`;
    }
    if (normalizedType === 'incident') {
      const scope = siteName ?? clientName ?? resolvedClientId ?? 'GreenBro';
      return `Incident report link — ${scope}`;
    }
    return 'Report link';
  })();
  const subject = subjectInput || defaultSubject;
  if (uniqueRecipients.length === 0) {
    await logReportDelivery(c.env.DB, {
      type: normalizedType,
      status: 'skipped',
      clientId: resolvedClientId ?? null,
      siteId: siteId || null,
      path: normalizedPath,
      subject,
      meta: { resend: true, reason: 'no_recipients', actor: auth.email ?? auth.sub },
    });
    return c.text('No recipients configured', 400);
  }

  const settings = await loadEmailSettings(c.env.DB);
  if (!settings.webhook || !settings.from) {
    await logReportDelivery(c.env.DB, {
      type: normalizedType,
      status: 'skipped',
      clientId: resolvedClientId ?? null,
      siteId: siteId || null,
      path: normalizedPath,
      subject,
      to: uniqueRecipients,
      meta: { resend: true, reason: 'email_config_missing', actor: auth.email ?? auth.sub },
    });
    return c.text('Email settings incomplete', 503);
  }

  const origin = new URL(c.req.url);
  const downloadUrl = `${origin.origin}${normalizedPath}`;
  const lines = [
    `Report type: ${normalizedType}`,
    resolvedClientId
      ? `Client: ${clientName ?? resolvedClientId} (${resolvedClientId})`
      : clientName
        ? `Client: ${clientName}`
        : null,
    siteId ? `Site: ${siteName ?? siteId} (${siteId})` : siteName ? `Site: ${siteName}` : null,
    `Download: ${downloadUrl}`,
    `R2 path: ${normalizedPath}`,
    `Requested by: ${auth.email ?? auth.sub}`,
  ].filter((line): line is string => typeof line === 'string' && line.length > 0);

  const detailLines = lines.filter((line) => !line.startsWith('R2 path') && !line.startsWith('Requested by'));
  const footerLines = lines.filter((line) => line.startsWith('R2 path') || line.startsWith('Requested by'));
  const html = brandEmail({
    title: subject,
    introLines: [`Here's the latest ${normalizedType} report link from GreenBro Control Centre.`],
    detailLines,
    footerLines,
    cta: { href: downloadUrl, label: 'Open report' },
  });
  const emailed = await sendEmail(c.env, uniqueRecipients, subject, lines.join('\n'), settings, html);
  const status = emailed ? 'sent' : 'send_failed';
  await logReportDelivery(c.env.DB, {
    type: normalizedType,
    status,
    clientId: resolvedClientId ?? null,
    siteId: siteId || null,
    path: normalizedPath,
    subject,
    to: uniqueRecipients,
    meta: { resend: true, actor: auth.email ?? auth.sub },
  });
  if (!emailed) {
    return c.text('Failed to send email', 502);
  }
  return c.json({ ok: true, recipients: uniqueRecipients, subject, path: normalizedPath });
});

app.post('/api/reports/client-monthly/v2', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('client_id');
  const monthParam = url.searchParams.get('month');
  if (!clientId || !monthParam) {
    return c.text('client_id and month required', 400);
  }

  let prepared;
  try {
    prepared = await buildClientMonthlyReportPayload(c.env, clientId, monthParam, { version: 'v2' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to prepare report';
    if (message === 'Client not found') {
      return c.text(message, 404);
    }
    return c.text(message, 400);
  }

  const { payload, client } = prepared;

  const pdf = await generateClientMonthlyReport(c.env, payload);
  const path = keyToPath(pdf.key);
  await logReportDelivery(c.env.DB, {
    type: 'monthly',
    status: 'generated',
    clientId: client.id,
    siteId: null,
    path,
    subject: `Monthly report — ${payload.monthLabel} (${client.name})`,
    meta: { month: monthParam, version: 'v2' },
  });
  const recipients = parseRecipientList(payload.recipients ?? null);
  let emailed = false;
  if (recipients.length > 0) {
    const settings = await loadEmailSettings(c.env.DB);
    const subject = `Monthly report — ${payload.monthLabel} (${client.name})`;
    const detailLines = [
      `Client: ${client.name} (${client.id})`,
      `Period: ${payload.periodStart} → ${payload.periodEnd}`,
      `Sites: ${payload.siteCount} · Devices: ${payload.deviceCount}`,
      payload.metrics.uptimePct == null
        ? 'Uptime: n/a'
        : `Uptime: ${(payload.metrics.uptimePct * 100).toFixed(2)}%`,
      `Download: ${pdf.url}`,
    ];
    const footerLines = [`R2 path: ${path}`];
    const html = brandEmail({
      title: `Monthly report ready — ${payload.monthLabel}`,
      introLines: [`${client.name}'s monthly performance summary is ready.`],
      detailLines,
      footerLines,
      cta: { href: pdf.url, label: 'View report' },
    });
    const text = [...detailLines, ...footerLines].join('\n');
    emailed = await sendEmail(c.env, recipients, subject, text, settings, html);
    await logReportDelivery(c.env.DB, {
      type: 'monthly',
      status: emailed ? 'sent' : 'send_failed',
      clientId: client.id,
      siteId: null,
      path,
      subject,
      to: recipients,
      meta: { month: monthParam, version: 'v2', auto: true },
    });
  }

  return c.json({
    ok: true,
    key: pdf.key,
    path,
    url: pdf.url,
    client,
    month: monthParam,
    metrics: payload.metrics,
    targets: payload.targets,
    siteCount: payload.siteCount,
    deviceCount: payload.deviceCount,
    recipients,
    emailed,
  });
});

app.get('/api/reports/client-monthly', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('client_id');
  if (!clientId) {
    return c.text('client_id required', 400);
  }
  const limitParam = url.searchParams.get('limit');
  const limit = Number(limitParam ?? '20');
  const max = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;
  const list = await c.env.REPORTS.list({ prefix: `client-reports/${clientId}/`, limit: max });
  const objects = list.objects ?? [];
  const out = objects.map((obj) => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded?.toISOString?.() ?? obj.uploaded,
    url: `/api/reports/${obj.key}`,
  }));
  return c.json(out);
});

app.get('/api/reports/history', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const normalize = (key: string) => {
    const value = url.searchParams.get(key);
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const limitParam = url.searchParams.get('limit');
  const rows = await listReportDeliveries(c.env.DB, {
    clientId: normalize('client_id'),
    siteId: normalize('site_id'),
    type: normalize('type'),
    status: normalize('status'),
    limit: limitParam ? Number(limitParam) : undefined,
  });
  return c.json(rows);
});

app.get('/api/clients/:clientId/slo-summary', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const clientId = c.req.param('clientId');
  if (!canAccessClient(auth, clientId)) {
    return c.text('Forbidden', 403);
  }
  const url = new URL(c.req.url);
  const month = url.searchParams.get('month');
  try {
    const summary = await buildClientSloSummary(c.env, clientId, month);
    return c.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build summary';
    if (message === 'Client not found') {
      return c.text(message, 404);
    }
    return c.text(message, 400);
  }
});

app.get('/api/clients/:clientId/uptime-daily', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const clientId = c.req.param('clientId');
  if (!canAccessClient(auth, clientId)) {
    return c.text('Forbidden', 403);
  }
  const url = new URL(c.req.url);
  const monthParam = url.searchParams.get('month') ?? formatMonthKey(new Date());
  const range = parseMonthRange(monthParam);
  if (!range) {
    return c.text('Invalid month format', 400);
  }

  const mapRows = await c.env.DB.prepare(
    `SELECT DISTINCT d.device_id
       FROM devices d
       JOIN site_clients sc ON sc.site_id = d.site_id
      WHERE sc.client_id = ?`,
  )
    .bind(clientId)
    .all<{ device_id: string | null }>();
  const deviceIds = (mapRows.results ?? [])
    .map((row) => row.device_id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  const now = new Date();
  const effectiveEndMs = (() => {
    const monthEnd = range.end.getTime();
    const nowMs = now.getTime();
    if (nowMs >= monthEnd) {
      return monthEnd;
    }
    if (nowMs <= range.start.getTime()) {
      return range.start.getTime();
    }
    return nowMs;
  })();

  const dayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.max(0, Math.floor((range.end.getTime() - range.start.getTime()) / dayMs));
  const series: Array<{ date: string; uptimePct: number | null }> = [];

  for (let i = 0; i < totalDays; i += 1) {
    const dayStart = new Date(range.start.getTime() + i * dayMs);
    const dayEnd = new Date(dayStart.getTime() + dayMs);
    const isoDate = dayStart.toISOString().slice(0, 10);
    if (dayStart.getTime() >= effectiveEndMs || deviceIds.length === 0) {
      series.push({ date: isoDate, uptimePct: null });
      continue;
    }
    const windowEndMs = Math.min(dayEnd.getTime(), effectiveEndMs);
    if (windowEndMs <= dayStart.getTime()) {
      series.push({ date: isoDate, uptimePct: null });
      continue;
    }
    let uptime: number | null = null;
    try {
      uptime = await computeTimeWeightedUptime(
        c.env.DB,
        deviceIds,
        dayStart.toISOString(),
        new Date(windowEndMs).toISOString(),
        5,
      );
    } catch (error) {
      console.warn('daily uptime compute failed', clientId, isoDate, error);
    }
    series.push({ date: isoDate, uptimePct: uptime });
  }

  return c.json({
    clientId,
    month: formatMonthKey(range.start),
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    effectiveEnd: new Date(effectiveEndMs).toISOString(),
    freshnessMinutes: 5,
    deviceCount: deviceIds.length,
    series,
  });
});

app.post('/api/ops/monthly-run', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  let body: { month?: string } | null = null;
  try {
    body = await c.req.json<{ month?: string }>();
  } catch {}

  const month = body?.month ?? previousMonthKey();
  if (!parseMonthRange(month)) {
    return c.text('Invalid month format', 400);
  }

  const rows = await c.env.DB.prepare('SELECT client_id FROM client_slos').all<{ client_id: string }>();
  const emailSettings = await loadEmailSettings(c.env.DB);
  const results: Array<{
    clientId: string;
    ok: boolean;
    key?: string;
    path?: string;
    url?: string;
    recipients?: string[];
    emailed?: boolean;
    error?: string;
  }> = [];

  for (const row of rows.results ?? []) {
    try {
      const { payload, client } = await buildClientMonthlyReportPayload(c.env, row.client_id, month, { version: 'v2' });
      const pdf = await generateClientMonthlyReport(c.env, payload);
      const recipients = parseRecipientList(payload.recipients ?? null);
      let emailed = false;
      if (recipients.length > 0) {
        const subject = `Monthly report — ${payload.monthLabel} (${client.name})`;
        const detailLines = [
          `Client: ${client.name} (${client.id})`,
          `Period: ${payload.periodStart} → ${payload.periodEnd}`,
          `Sites: ${payload.siteCount} · Devices: ${payload.deviceCount}`,
          payload.metrics.uptimePct == null
            ? 'Uptime: n/a'
            : `Uptime: ${(payload.metrics.uptimePct * 100).toFixed(2)}%`,
          `Download: ${pdf.url}`,
        ];
        const reportPath = keyToPath(pdf.key);
        const footerLines = [`R2 path: ${reportPath}`];
        const html = brandEmail({
          title: `Monthly report ready — ${payload.monthLabel}`,
          introLines: [`${client.name}'s monthly performance summary is ready.`],
          detailLines,
          footerLines,
          cta: { href: pdf.url, label: 'View report' },
        });
        const text = [...detailLines, ...footerLines].join('\n');
        emailed = await sendEmail(c.env, recipients, subject, text, emailSettings, html);
      }
      results.push({
        clientId: client.id,
        ok: true,
        key: pdf.key,
        path: keyToPath(pdf.key),
        url: pdf.url,
        recipients,
        emailed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate report';
      results.push({ clientId: row.client_id, ok: false, error: message });
    }
  }

  return c.json({ ok: true, month, total: results.length, results });
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

app.get('/api/ops/check-fastburn', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const result = await fastBurnMonitor(c.env);
  return c.json(result);
});

app.get('/api/ops/slo', async (c) => {
  try {
    await fastBurnMonitor(c.env);
  } catch (error) {
    console.warn('fast burn monitor error', error);
  }
  const snapshot = await computeOpsSnapshot(c.env.DB);
  return c.json(snapshot);
});

app.get('/api/ops/burn-series', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const url = new URL(c.req.url);
  const windowMinutes = parseDurationMinutes(url.searchParams.get('window')) ?? 10;
  const stepMinutesRaw = parseDurationMinutes(url.searchParams.get('step')) ?? 1;
  const stepMinutes = Math.max(1, stepMinutesRaw);
  const steps = Math.max(1, Math.ceil(windowMinutes / stepMinutes));
  const cappedSteps = Math.min(steps, 600);
  const targetParam = url.searchParams.get('target');
  const parsedTarget = targetParam != null ? Number(targetParam) : Number.NaN;
  const target = Number.isFinite(parsedTarget) && parsedTarget > 0 && parsedTarget < 1 ? parsedTarget : 0.999;

  const rows = await c.env.DB.prepare(
    `SELECT CAST(strftime('%s', ts) / (? * 60) AS INTEGER) AS bucket,
            SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok,
            COUNT(*) AS total
       FROM ops_metrics
      WHERE route='/api/ingest' AND ts >= datetime('now', ?)
      GROUP BY bucket
      ORDER BY bucket`,
  )
    .bind(stepMinutes, `-${windowMinutes} minutes`)
    .all<{ bucket: number | null; ok: number | null; total: number | null }>();

  const buckets = new Map<number, { ok: number; total: number }>();
  for (const row of rows.results ?? []) {
    if (row.bucket == null) continue;
    buckets.set(row.bucket, { ok: row.ok ?? 0, total: row.total ?? 0 });
  }

  const nowBucket = Math.floor(Date.now() / (stepMinutes * 60 * 1000));
  const denom = 1 - target;
  const series: number[] = [];
  for (let i = cappedSteps - 1; i >= 0; i--) {
    const bucketIndex = nowBucket - i;
    const bucket = buckets.get(bucketIndex);
    const total = bucket?.total ?? 0;
    const ok = bucket?.ok ?? 0;
    const errRate = total > 0 ? 1 - ok / total : 0;
    const burn = denom > 0 ? errRate / denom : 0;
    series.push(Number.isFinite(burn) ? burn : 0);
  }

  return c.json({ series });
});

app.get('/api/ops/health', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const status = await fetchLatestCanary(c.env.DB);
  return c.json(status);
});

app.get('/ops', async (c) => {
  const snapshot = await computeOpsSnapshot(c.env.DB);
  return c.render(<OpsPage snapshot={snapshot} />);
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

app.get('/clients/:clientId/slo', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const clientId = c.req.param('clientId');
  if (!canAccessClient(auth, clientId)) {
    return c.text('Forbidden', 403);
  }
  const url = new URL(c.req.url);
  const monthParam = url.searchParams.get('month');
  try {
    const summary = await buildClientSloSummary(c.env, clientId, monthParam);
    return c.render(
      <ClientSloPage
        summary={summary}
        filters={{
          month: monthParam ?? summary.month.key,
        }}
      />,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load summary';
    if (message === 'Client not found') {
      return c.text(message, 404);
    }
    return c.text(message, 400);
  }
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

app.get('/admin/archive', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const parsed = parseDateParam(url.searchParams.get('date'));
  const fallback = addUtcDays(startOfUtcDay(new Date()), -1);
  const target = parsed ?? fallback;
  const rows = await listArchiveRows(c.env.DB, target);
  return c.render(<AdminArchivePage date={formatDateKey(target)} rows={rows} />);
});

app.get('/admin/presets', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  return c.render(<AdminPresetsPage />);
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

app.get('/admin/email', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  return c.render(<AdminEmailPage />);
});

app.get('/admin/maintenance', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  return c.render(<AdminMaintenancePage />);
});

app.get('/admin/settings', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  return c.render(<AdminSettingsPage />);
});

app.get('/admin/reports/outbox', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const getRaw = (key: string) => url.searchParams.get(key) ?? '';
  const statusValue = url.searchParams.has('status') ? getRaw('status') : 'generated';
  const limitParam = getRaw('limit') || '50';
  const rows = await listReportDeliveries(c.env.DB, {
    type: getRaw('type') ? getRaw('type') : null,
    status: statusValue ? statusValue : null,
    clientId: getRaw('client_id') ? getRaw('client_id') : null,
    siteId: getRaw('site_id') ? getRaw('site_id') : null,
    limit: limitParam ? Number(limitParam) : undefined,
  });
  return c.render(
    <AdminReportsOutboxPage
      rows={rows}
      filters={{
        type: getRaw('type'),
        status: statusValue,
        clientId: getRaw('client_id'),
        siteId: getRaw('site_id'),
        limit: limitParam,
      }}
    />,
  );
});

app.get('/admin/reports', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  return c.render(<AdminReportsPage />);
});

app.get('/admin/reports/history', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const get = (key: string) => {
    const value = url.searchParams.get(key);
    return value ?? '';
  };
  const limitParam = url.searchParams.get('limit');
  const rows = await listReportDeliveries(c.env.DB, {
    clientId: get('client_id') ? get('client_id') : null,
    siteId: get('site_id') ? get('site_id') : null,
    type: get('type') ? get('type') : null,
    status: get('status') ? get('status') : null,
    limit: limitParam ? Number(limitParam) : undefined,
  });
  return c.render(
    <AdminReportsHistoryPage
      rows={rows}
      filters={{
        clientId: get('client_id'),
        siteId: get('site_id'),
        type: get('type'),
        status: get('status'),
        limit: limitParam ?? '',
      }}
    />,
  );
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

async function logOpsMetric(
  DB: D1Database,
  route: string,
  statusCode: number,
  durationMs: number,
  deviceId?: string | null,
) {
  try {
    await DB.prepare(
      'INSERT INTO ops_metrics (ts, route, status_code, duration_ms, device_id) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(new Date().toISOString(), route, statusCode, durationMs, deviceId ?? null)
      .run();
  } catch (error) {
    console.warn('logOpsMetric failed', error);
  }
}

function parseIsoTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed.toISOString();
}

type MonthRange = { start: Date; end: Date; label: string };

function parseMonthRange(month: string): MonthRange | null {
  const m = /^([0-9]{4})-([0-9]{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
  const label = start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return { start, end, label };
}

function formatMonthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function previousMonthKey(reference: Date = new Date()): string {
  const base = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
  base.setUTCMonth(base.getUTCMonth() - 1);
  return formatMonthKey(base);
}

async function computeTimeWeightedUptime(
  DB: D1Database,
  deviceIds: string[],
  startIso: string,
  endIso: string,
  freshnessMinutes = 5,
): Promise<number | null> {
  if (deviceIds.length === 0) {
    return null;
  }
  const start = new Date(startIso);
  const end = new Date(endIso);
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }

  const placeholders = deviceIds.map(() => '?').join(',');
  const heartbeats = await DB.prepare(
    `SELECT device_id, ts
       FROM heartbeat
      WHERE device_id IN (${placeholders})
        AND ts >= ?
        AND ts <= ?
      ORDER BY device_id, ts`,
  )
    .bind(...deviceIds, startIso, endIso)
    .all<{ device_id: string; ts: string }>()
    .catch(() => ({ results: [] }));

  const previous = await DB.prepare(
    `SELECT device_id, MAX(ts) as ts
       FROM heartbeat
      WHERE device_id IN (${placeholders})
        AND ts < ?
      GROUP BY device_id`,
  )
    .bind(...deviceIds, startIso)
    .all<{ device_id: string; ts: string | null }>()
    .catch(() => ({ results: [] }));

  const perDevice = new Map<string, number[]>();
  for (const id of deviceIds) {
    perDevice.set(id, []);
  }

  for (const row of heartbeats.results ?? []) {
    const bucket = perDevice.get(row.device_id);
    if (!bucket) continue;
    const ts = new Date(row.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    bucket.push(ts);
  }

  for (const row of previous.results ?? []) {
    if (!row.ts) continue;
    const bucket = perDevice.get(row.device_id);
    if (!bucket) continue;
    const ts = new Date(row.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    bucket.push(ts);
  }

  const thresholdMs = freshnessMinutes * 60 * 1000;
  const windowMs = endMs - startMs;
  let totalOnlineMs = 0;

  for (const id of deviceIds) {
    const beats = perDevice.get(id) ?? [];
    if (beats.length === 0) {
      continue;
    }
    beats.sort((a, b) => a - b);
    const intervals: Array<{ start: number; end: number }> = [];
    for (const beatMs of beats) {
      const intervalStart = Math.max(beatMs, startMs);
      const intervalEnd = Math.min(beatMs + thresholdMs, endMs);
      if (intervalEnd <= intervalStart) {
        continue;
      }
      intervals.push({ start: intervalStart, end: intervalEnd });
    }
    if (intervals.length === 0) {
      continue;
    }
    intervals.sort((a, b) => a.start - b.start);
    let current = intervals[0];
    for (let i = 1; i < intervals.length; i++) {
      const next = intervals[i];
      if (next.start <= current.end) {
        current.end = Math.max(current.end, next.end);
      } else {
        totalOnlineMs += current.end - current.start;
        current = { ...next };
      }
    }
    totalOnlineMs += current.end - current.start;
  }

  const denominator = windowMs * deviceIds.length;
  if (denominator <= 0) {
    return null;
  }
  return totalOnlineMs / denominator;
}

type ClientMonthlyMetrics = {
  uptimePct: number | null;
  ingestSuccessPct: number | null;
  avgCop: number | null;
  alerts: Array<{ type: string; severity: string; count: number }>;
};

async function computeClientMonthlyMetricsV1(
  DB: D1Database,
  clientId: string,
  deviceIds: string[],
  startIso: string,
  endIso: string,
): Promise<ClientMonthlyMetrics> {
  let uptimePct: number | null = null;
  let avgCop: number | null = null;

  if (deviceIds.length > 0) {
    const placeholders = deviceIds.map(() => '?').join(',');
    const telemetryRow = await DB.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN COALESCE(json_extract(status_json,'$.online'),0) = 1 THEN 1 ELSE 0 END) as online_count,
              AVG(cop) as avg_cop
         FROM telemetry
        WHERE device_id IN (${placeholders})
          AND ts >= ?
          AND ts < ?`,
    )
      .bind(...deviceIds, startIso, endIso)
      .first<{ total: number | null; online_count: number | null; avg_cop: number | null }>()
      .catch(() => null);
    const total = toNumber(telemetryRow?.total) ?? 0;
    const online = toNumber(telemetryRow?.online_count) ?? 0;
    if (total > 0) {
      uptimePct = online / total;
    }
    avgCop = toNumber(telemetryRow?.avg_cop);
  }

  const ingestRow = await DB.prepare(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) as ok
       FROM ops_metrics
      WHERE route='/api/ingest'
        AND ts >= ?
        AND ts < ?`,
  )
    .bind(startIso, endIso)
    .first<{ total: number | null; ok: number | null }>()
    .catch(() => null);

  const ingestTotal = toNumber(ingestRow?.total) ?? 0;
  const ingestOk = toNumber(ingestRow?.ok) ?? 0;
  const ingestSuccessPct = ingestTotal > 0 ? ingestOk / ingestTotal : null;

  const alertRows = await DB.prepare(
    `SELECT a.type, a.severity, COUNT(*) as count
       FROM alerts a
       JOIN devices d ON d.device_id = a.device_id
       JOIN site_clients sc ON sc.site_id = d.site_id
      WHERE sc.client_id = ?
        AND a.opened_at >= ?
        AND a.opened_at < ?
      GROUP BY a.type, a.severity
      ORDER BY count DESC`,
  )
    .bind(clientId, startIso, endIso)
    .all<{ type: string; severity: string; count: number }>()
    .catch(() => ({ results: [] }));

  const alerts = (alertRows.results ?? []).map((row) => ({ type: row.type, severity: row.severity, count: row.count }));

  return { uptimePct, ingestSuccessPct, avgCop, alerts };
}

async function computeClientMonthlyMetricsV2(
  DB: D1Database,
  clientId: string,
  deviceIds: string[],
  startIso: string,
  endIso: string,
): Promise<ClientMonthlyMetrics> {
  const base = await computeClientMonthlyMetricsV1(DB, clientId, deviceIds, startIso, endIso);
  const weighted = await computeTimeWeightedUptime(DB, deviceIds, startIso, endIso, 5);
  return { ...base, uptimePct: weighted ?? base.uptimePct };
}

async function buildClientMonthlyReportPayload(
  env: Env,
  clientId: string,
  monthKey: string,
  options?: { version?: 'v1' | 'v2' },
): Promise<{ payload: ClientMonthlyReportPayload; client: { id: string; name: string } }> {
  const range = parseMonthRange(monthKey);
  if (!range) {
    throw new Error('Invalid month format');
  }

  const client = await env.DB.prepare('SELECT client_id, name FROM clients WHERE client_id=?')
    .bind(clientId)
    .first<{ client_id: string; name: string | null }>();
  if (!client) {
    throw new Error('Client not found');
  }

  const mapRows = await env.DB.prepare(
    `SELECT DISTINCT d.device_id, d.site_id
       FROM devices d
       JOIN site_clients sc ON sc.site_id = d.site_id
      WHERE sc.client_id = ?`,
  )
    .bind(clientId)
    .all<{ device_id: string; site_id: string | null }>();

  const deviceIds = (mapRows.results ?? []).map((row) => row.device_id).filter((id): id is string => !!id);
  const siteIds = new Set<string>();
  for (const row of mapRows.results ?? []) {
    if (row.site_id) {
      siteIds.add(row.site_id);
    }
  }

  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();

  const metrics =
    options?.version === 'v2'
      ? await computeClientMonthlyMetricsV2(env.DB, clientId, deviceIds, startIso, endIso)
      : await computeClientMonthlyMetricsV1(env.DB, clientId, deviceIds, startIso, endIso);

  const slo = await env.DB.prepare(
    'SELECT uptime_target, ingest_target, cop_target, report_recipients FROM client_slos WHERE client_id=?',
  )
    .bind(clientId)
    .first<{ uptime_target: number | null; ingest_target: number | null; cop_target: number | null; report_recipients: string | null }>();

  const periodEndDisplay = new Date(range.end.getTime() - 1);

  const payload: ClientMonthlyReportPayload = {
    clientId,
    clientName: client.name ?? clientId,
    monthLabel: range.label,
    monthKey,
    periodStart: startIso,
    periodEnd: periodEndDisplay.toISOString(),
    siteCount: siteIds.size,
    deviceCount: deviceIds.length,
    metrics,
    targets: {
      uptimeTarget: toNumber(slo?.uptime_target),
      ingestTarget: toNumber(slo?.ingest_target),
      copTarget: toNumber(slo?.cop_target),
    },
    recipients: slo?.report_recipients ?? null,
  };

  return { payload, client: { id: clientId, name: client.name ?? clientId } };
}

async function buildClientSloSummary(env: Env, clientId: string, monthParam?: string | null): Promise<ClientSloSummary> {
  const now = new Date();
  let monthKey = monthParam ?? formatMonthKey(now);
  let range = parseMonthRange(monthKey);
  if (!range) {
    monthKey = formatMonthKey(now);
    range = parseMonthRange(monthKey);
  }
  if (!range) {
    throw new Error('Invalid month');
  }

  const client = await env.DB.prepare('SELECT client_id, name FROM clients WHERE client_id=?')
    .bind(clientId)
    .first<{ client_id: string; name: string | null }>();
  if (!client) {
    throw new Error('Client not found');
  }

  const mapRows = await env.DB.prepare(
    `SELECT DISTINCT d.device_id, d.site_id
       FROM devices d
       JOIN site_clients sc ON sc.site_id = d.site_id
      WHERE sc.client_id = ?`,
  )
    .bind(clientId)
    .all<{ device_id: string | null; site_id: string | null }>();

  const deviceIds = (mapRows.results ?? [])
    .map((row) => row.device_id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const siteIds = new Set<string>();
  for (const row of mapRows.results ?? []) {
    if (row.site_id) {
      siteIds.add(row.site_id);
    }
  }

  const startIso = range.start.toISOString();
  const monthEndMs = range.end.getTime();
  const nowMs = now.getTime();
  let effectiveEnd = range.end;
  if (nowMs >= range.start.getTime()) {
    effectiveEnd = nowMs < monthEndMs ? new Date(nowMs) : range.end;
  }
  const endIso = effectiveEnd.toISOString();

  const metrics = await computeClientMonthlyMetricsV2(env.DB, clientId, deviceIds, startIso, endIso);

  const alertsBySeverity: Record<string, number> = {};
  for (const alert of metrics.alerts) {
    alertsBySeverity[alert.severity] = (alertsBySeverity[alert.severity] ?? 0) + alert.count;
  }

  const slo = await env.DB.prepare(
    'SELECT uptime_target, ingest_target, cop_target, report_recipients FROM client_slos WHERE client_id=?',
  )
    .bind(clientId)
    .first<{ uptime_target: number | null; ingest_target: number | null; cop_target: number | null; report_recipients: string | null }>();

  const dayMs = 24 * 60 * 60 * 1000;
  const sparkEnd = new Date(nowMs);
  const sparkStart = new Date(sparkEnd.getTime() - 6 * dayMs);
  const copSparkline: Array<{ ts: string; value: number | null }> = [];
  for (let i = 0; i < 7; i += 1) {
    const point = new Date(sparkStart.getTime() + i * dayMs);
    copSparkline.push({ ts: point.toISOString().slice(0, 10), value: null });
  }

  if (deviceIds.length > 0) {
    const placeholders = deviceIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', ts) AS day, AVG(cop) AS avg_cop
         FROM telemetry
        WHERE device_id IN (${placeholders})
          AND ts >= ?
          AND ts <= ?
        GROUP BY day
        ORDER BY day`,
    )
      .bind(...deviceIds, sparkStart.toISOString(), sparkEnd.toISOString())
      .all<{ day: string; avg_cop: number | null }>();

    const lookup = new Map<string, number | null>();
    for (const row of rows.results ?? []) {
      lookup.set(row.day, toNumber(row.avg_cop));
    }
    copSparkline.forEach((point, idx) => {
      const value = lookup.has(point.ts) ? lookup.get(point.ts) ?? null : null;
      copSparkline[idx] = { ts: point.ts, value };
    });
  }

  return {
    clientId: client.client_id,
    clientName: client.name ?? client.client_id,
    month: {
      key: monthKey,
      label: range.label,
      start: startIso,
      end: range.end.toISOString(),
      effectiveEnd: endIso,
    },
    siteCount: siteIds.size,
    deviceCount: deviceIds.length,
    metrics: {
      uptimePct: metrics.uptimePct,
      ingestSuccessPct: metrics.ingestSuccessPct,
      avgCop: metrics.avgCop,
      alerts: metrics.alerts,
      alertsBySeverity,
    },
    targets: {
      uptimeTarget: toNumber(slo?.uptime_target),
      ingestTarget: toNumber(slo?.ingest_target),
      copTarget: toNumber(slo?.cop_target),
    },
    recipients: slo?.report_recipients ?? null,
    copSparkline,
    heartbeatFreshnessMinutes: 5,
    window: { start: startIso, end: endIso },
    updatedAt: new Date().toISOString(),
  };
}

async function fetchLatestCanary(DB: D1Database): Promise<{ lastAt: string | null; minutesSince: number | null; status: 'ok' | 'warn' | 'crit' }> {
  try {
    const row = await DB.prepare(
      "SELECT ts FROM ops_metrics WHERE route IN ('/ops/canary','/api/ops/canary','ops_canary','canary') ORDER BY ts DESC LIMIT 1",
    ).first<{ ts: string | null }>();
    const raw = row?.ts ?? null;
    if (!raw) {
      return { lastAt: null, minutesSince: null, status: 'crit' };
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.valueOf())) {
      return { lastAt: null, minutesSince: null, status: 'crit' };
    }
    const diffMs = Date.now() - parsed.valueOf();
    const minutes = Number.isFinite(diffMs) ? Math.max(0, diffMs / 60000) : null;
    const status = minutes == null ? 'crit' : minutes <= 10 ? 'ok' : minutes <= 15 ? 'warn' : 'crit';
    return { lastAt: parsed.toISOString(), minutesSince: minutes, status };
  } catch (error) {
    console.warn('fetchLatestCanary failed', error);
    return { lastAt: null, minutesSince: null, status: 'crit' };
  }
}

async function computeOpsSnapshot(DB: D1Database): Promise<OpsSnapshot> {
  const totalRow = await DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success FROM ops_metrics WHERE route='/api/ingest'",
  )
    .first<{ total: number | null; success: number | null }>()
    .catch(() => null);

  const overallTotal = toNumber(totalRow?.total) ?? 0;
  const overallSuccess = toNumber(totalRow?.success) ?? 0;
  const overallError = Math.max(0, overallTotal - overallSuccess);
  const overallSuccessPct = overallTotal > 0 ? (overallSuccess / overallTotal) * 100 : 100;

  const windowRow = await DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success FROM (SELECT status_code FROM ops_metrics WHERE route='/api/ingest' ORDER BY ts DESC LIMIT 1000)",
  )
    .first<{ total: number | null; success: number | null }>()
    .catch(() => null);

  const windowTotal = toNumber(windowRow?.total) ?? 0;
  const windowSuccess = toNumber(windowRow?.success) ?? 0;
  const windowError = Math.max(0, windowTotal - windowSuccess);
  const windowSuccessPct = windowTotal > 0 ? (windowSuccess / windowTotal) * 100 : 100;
  let burnWindow: BurnSnapshot = { total: 0, ok: 0, errRate: 0, burn: 0 };
  try {
    burnWindow = await computeBurn(DB, 10, 0.999);
  } catch (error) {
    console.warn('computeBurn failed', error);
  }

  const heartbeatRow = await DB.prepare(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) AS online FROM devices',
  )
    .first<{ total: number | null; online: number | null }>()
    .catch(() => null);

  const heartbeatTotal = toNumber(heartbeatRow?.total) ?? 0;
  const heartbeatOnline = toNumber(heartbeatRow?.online) ?? 0;
  const heartbeatPct = heartbeatTotal > 0 ? (heartbeatOnline / heartbeatTotal) * 100 : 0;

  const canary = await fetchLatestCanary(DB);

  return {
    generatedAt: new Date().toISOString(),
    ingest: {
      total: {
        total: overallTotal,
        success: overallSuccess,
        successPct: Number.isFinite(overallSuccessPct) ? overallSuccessPct : 0,
        error: overallError,
      },
      window1k: {
        total: windowTotal,
        success: windowSuccess,
        successPct: Number.isFinite(windowSuccessPct) ? windowSuccessPct : 0,
        error: windowError,
      },
      burnRate: Number.isFinite(burnWindow.burn) ? burnWindow.burn : 0,
    },
    heartbeat: {
      total: heartbeatTotal,
      online: heartbeatOnline,
      onlinePct: Number.isFinite(heartbeatPct) ? heartbeatPct : 0,
    },
    canary,
  };
}

export async function queue(batch: MessageBatch<IngestMessage>, env: Env, ctx: ExecutionContext) {
  await baseQueueHandler(batch, env, ctx);

  for (const message of batch.messages) {
    if (message.body?.type !== 'telemetry') continue;
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

export default {
  fetch: app.fetch,
  queue,
  scheduled: async (evt: ScheduledEvent, env: Env) => {
    const cron = evt.cron ?? '';
    try {
      await fastBurnMonitor(env);
    } catch (error) {
      console.error('fast burn monitor error', error);
    }
    const shouldRunNightly = !cron || cron === '0 2 * * *' || cron === '15 2 1 * *';
    if (shouldRunNightly) {
      await evaluateHeartbeatAlerts(env, new Date().toISOString()).catch((error) => {
        console.error('heartbeat sweep error', error);
      });
      await recomputeBaselines(env.DB).catch((error) => {
        console.error('baseline recompute error', error);
      });
      await sweepIncidents(env.DB).catch((error) => {
        console.error('incident sweep error', error);
      });
    }

    if (!cron || cron === '15 2 1 * *') {
      const reference = evt.scheduledTime ? new Date(evt.scheduledTime) : new Date();
      const monthKey = previousMonthKey(reference);
      const sloRows = await env.DB.prepare('SELECT client_id FROM client_slos').all<{ client_id: string }>();
      for (const row of sloRows.results ?? []) {
        try {
          const { payload } = await buildClientMonthlyReportPayload(env, row.client_id, monthKey);
          await generateClientMonthlyReport(env, payload);
        } catch (error) {
          console.error('monthly report generation failed', row.client_id, error);
        }
      }
    }

    try {
      await pruneStaged(env, 14);
    } catch {}
  },
};
