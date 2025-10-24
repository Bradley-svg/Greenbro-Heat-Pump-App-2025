import type { Env, DurableObjectState } from './types/env';
import type { TelemetryPayload } from './types';

type BaselineSample = { t: number; dt?: number; cop?: number; cur?: number };
type BaselineDeviationState = {
  buf: BaselineSample[];
  lastDev: { state: 'ok' | 'warn' | 'crit'; since: number } | null;
};

const WINDOW_MS = 10 * 60 * 1000;

type AuditPayload = Record<string, unknown>;

interface TelemetrySnapshot {
  telemetry: TelemetryPayload;
  receivedAt: string;
}

interface HeartbeatSnapshot {
  ts: string;
  rssi?: number;
  receivedAt: string;
}

interface CommandSnapshot {
  issuedAt: string;
  actor: string;
  applied: CommandBody;
  original: CommandBody;
  clamped?: Partial<CommandBody> | null;
}

interface CommandBody {
  dhwSetC?: number;
  mode?: string;
}

interface DeviceStateSnapshot {
  telemetry?: TelemetrySnapshot;
  heartbeat?: HeartbeatSnapshot;
  commands: CommandSnapshot[];
}

type CommandEnvelope = {
  deviceId: string;
  actor: string;
  command: CommandBody;
  limits: { minC: number; maxC: number };
};

export class DeviceStateDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private snapshot: DeviceStateSnapshot = { commands: [] };
  private baseline: BaselineDeviationState = { buf: [], lastDev: null };
  private readonly ready: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<DeviceStateSnapshot>('snapshot');
      if (stored) {
        this.snapshot = {
          commands: Array.isArray(stored.commands) ? stored.commands : [],
          telemetry: stored.telemetry,
          heartbeat: stored.heartbeat,
        };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/state') {
      return new Response(JSON.stringify(this.snapshot), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/window') {
      return new Response(JSON.stringify(this.baseline.buf), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/telemetry') {
      const body = (await request.json()) as TelemetrySnapshot;
      this.snapshot.telemetry = body;
      await this.persist();
      return new Response(null, { status: 204 });
    }

    if (request.method === 'POST' && url.pathname === '/append') {
      const { t, delta_t: deltaT, cop, current } = (await request.json()) as {
        t: number;
        delta_t?: number | null;
        cop?: number | null;
        current?: number | null;
      };
      if (typeof t === 'number' && Number.isFinite(t)) {
        this.appendSample(t, { delta_t: deltaT, cop, current });
      }
      return new Response('ok');
    }

    if (request.method === 'POST' && url.pathname === '/heartbeat') {
      const body = (await request.json()) as HeartbeatSnapshot;
      this.snapshot.heartbeat = body;
      await this.persist();
      return new Response(null, { status: 204 });
    }

    if (request.method === 'POST' && url.pathname === '/command') {
      const envelope = (await request.json()) as CommandEnvelope;
      const now = Date.now();

      const writesKey = 'writes';
      const lastWrites = (await this.state.storage.get<number[]>(writesKey)) ?? [];
      const recent = lastWrites.filter((ts) => now - ts < 60_000);
      if (recent.length >= 2) {
        await this.state.storage.put(writesKey, recent);
        return new Response(JSON.stringify({ result: 'rejected', reason: 'rate_limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }

      const before = await this.getLatestState(envelope.deviceId);
      const issuedAt = new Date(now).toISOString();
      const { applied, clamped } = clampCommand(envelope.command, envelope.limits);

      const record: CommandSnapshot = {
        issuedAt,
        actor: envelope.actor,
        applied,
        original: envelope.command,
        clamped,
      };
      this.snapshot.commands.unshift(record);
      if (this.snapshot.commands.length > 20) {
        this.snapshot.commands.length = 20;
      }
      await this.persist();

      const auditId = crypto.randomUUID();
      await this.env.DB.prepare(
        `INSERT INTO writes (id, device_id, ts, actor, before_json, after_json, clamped_json, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          auditId,
          envelope.deviceId,
          issuedAt,
          envelope.actor,
          JSON.stringify(before),
          JSON.stringify(applied),
          JSON.stringify(clamped ?? {}),
          'accepted',
        )
        .run();

      recent.push(now);
      await this.state.storage.put(writesKey, recent);

      return new Response(JSON.stringify({ result: 'accepted', desired: applied, clamped: clamped ?? {} }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (request.method === 'DELETE' && url.pathname === '/command') {
      this.snapshot.commands = [];
      await this.persist();
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('snapshot', this.snapshot);
  }

  private appendSample(
    t: number,
    v: { delta_t?: number | null; cop?: number | null; current?: number | null },
  ) {
    const item: BaselineSample = {
      t,
      dt: v.delta_t ?? undefined,
      cop: v.cop ?? undefined,
      cur: v.current ?? undefined,
    };
    this.baseline.buf.push(item);
    const cutoff = t - WINDOW_MS;
    while (this.baseline.buf.length && this.baseline.buf[0].t < cutoff) {
      this.baseline.buf.shift();
    }
  }

  private async getLatestState(deviceId: string): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare('SELECT * FROM latest_state WHERE device_id=?')
      .bind(deviceId)
      .first<Record<string, unknown>>();
    return row ?? {};
  }
}

export class DeviceDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const nowISO = new Date().toISOString();

    const ro = await this.env.DB.prepare("SELECT value FROM settings WHERE key='read_only'")
      .first<{ value: string }>();
    if (ro?.value === '1') {
      return new Response('Read-only mode', { status: 503 });
    }

    const bucket = (await this.state.storage.get<number>('bucket')) ?? 5;
    if (bucket <= 0) {
      return new Response('Rate limited', { status: 429 });
    }

    await this.state.storage.put('bucket', bucket - 1);
    await this.state.storage.setAlarm(Date.now() + 10_000);

    if (req.method === 'POST' && url.pathname.endsWith('/command')) {
      const payload = (await req.json<AuditPayload>().catch(() => ({}))) ?? {};
      const subject = req.headers.get('x-operator-subject') ?? 'operator';

      await this.env.DB.prepare(
        "INSERT INTO audit_log (id, ts, subject, device_id, action, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(
          crypto.randomUUID(),
          nowISO,
          subject,
          this.state.id.toString(),
          'command',
          JSON.stringify(payload),
        )
        .run();

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('OK');
  }

  async alarm(): Promise<void> {
    const bucket = (await this.state.storage.get<number>('bucket')) ?? 0;
    await this.state.storage.put('bucket', Math.min(bucket + 1, 5));
  }
}

function clampCommand(command: CommandBody, limits: { minC: number; maxC: number }) {
  const applied: CommandBody = { ...command };
  let clamped: Partial<CommandBody> | null = null;

  if (typeof command.dhwSetC === 'number' && Number.isFinite(command.dhwSetC)) {
    const { minC, maxC } = limits;
    const bounded = Math.min(Math.max(command.dhwSetC, minC), maxC);
    if (bounded !== command.dhwSetC) {
      clamped = { ...(clamped ?? {}), dhwSetC: bounded };
    }
    applied.dhwSetC = bounded;
  }

  if (typeof command.mode === 'string') {
    applied.mode = command.mode;
  }

  return { applied, clamped };
}
