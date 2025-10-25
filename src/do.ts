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

interface CommandAckSnapshot {
  status: 'applied' | 'failed' | 'expired';
  ts: string;
  details?: string;
}

interface CommandSnapshot {
  id: string;
  issuedAt: string;
  actor: string;
  applied: CommandBody;
  original: CommandBody;
  clamped?: Partial<CommandBody> | null;
  status: 'pending' | 'applied' | 'failed' | 'expired';
  expiresAt?: string | null;
  writeId?: string | null;
  ack?: CommandAckSnapshot | null;
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

function normalizeCommandSnapshot(input: unknown): CommandSnapshot {
  const fallbackId = `legacy_${crypto.randomUUID().replace(/-/g, '')}`;
  const raw = (input && typeof input === 'object' ? (input as any) : {}) as Record<string, unknown>;
  const id =
    typeof raw.id === 'string' && raw.id.length > 0
      ? raw.id
      : fallbackId;
  const issuedAt =
    typeof raw.issuedAt === 'string' && raw.issuedAt.length > 0 ? raw.issuedAt : new Date().toISOString();
  const actor = typeof raw.actor === 'string' && raw.actor.length > 0 ? raw.actor : 'operator';
  const applied = (raw.applied && typeof raw.applied === 'object' ? (raw.applied as CommandBody) : {}) as CommandBody;
  const original =
    (raw.original && typeof raw.original === 'object' ? (raw.original as CommandBody) : (applied as CommandBody)) ?? {};
  const clamped =
    raw.clamped && typeof raw.clamped === 'object' ? (raw.clamped as Partial<CommandBody>) : undefined;
  const status =
    raw.status === 'applied' || raw.status === 'failed' || raw.status === 'expired' ? (raw.status as any) : 'pending';
  const expiresAt =
    typeof raw.expiresAt === 'string' && raw.expiresAt.length > 0 ? (raw.expiresAt as string) : undefined;
  const writeId = typeof raw.writeId === 'string' && raw.writeId.length > 0 ? (raw.writeId as string) : undefined;
  const ack =
    raw.ack && typeof raw.ack === 'object' && typeof (raw.ack as any).status === 'string' && typeof (raw.ack as any).ts === 'string'
      ? {
          status: (raw.ack as any).status as 'applied' | 'failed' | 'expired',
          ts: (raw.ack as any).ts as string,
          ...(typeof (raw.ack as any).details === 'string' ? { details: (raw.ack as any).details as string } : {}),
        }
      : null;

  return {
    id,
    issuedAt,
    actor,
    applied,
    original,
    clamped: clamped ?? null,
    status,
    expiresAt: expiresAt ?? null,
    writeId,
    ack,
  };
}

type CommandEnvelope = {
  commandId: string;
  expiresAt?: string;
  deviceId: string;
  actor: string;
  command: CommandBody;
  limits: { minC: number; maxC: number };
};

export class DeviceStateSQLiteDO {
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
          commands: Array.isArray(stored.commands)
            ? stored.commands.map((cmd) => normalizeCommandSnapshot(cmd))
            : [],
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
      const kind = url.searchParams.get('kind') ?? 'delta_t';
      const data = this.baseline.buf.map((sample) => ({
        t: sample.t,
        v: kind === 'cop' ? sample.cop ?? null : kind === 'current' ? sample.cur ?? null : sample.dt ?? null,
      }));
      return new Response(JSON.stringify(data), {
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
      if (!envelope || typeof envelope.commandId !== 'string' || !envelope.commandId) {
        return new Response(JSON.stringify({ error: 'missing_command_id' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
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
      const expiresAt =
        typeof envelope.expiresAt === 'string' && envelope.expiresAt.length > 0
          ? envelope.expiresAt
          : new Date(now + 30 * 60 * 1000).toISOString();
      const { applied, clamped } = clampCommand(envelope.command, envelope.limits);

      const record: CommandSnapshot = {
        id: envelope.commandId,
        issuedAt,
        actor: envelope.actor,
        applied,
        original: envelope.command,
        clamped,
        status: 'pending',
        expiresAt,
        writeId: envelope.commandId,
        ack: null,
      };
      this.snapshot.commands.unshift(record);
      if (this.snapshot.commands.length > 20) {
        this.snapshot.commands.length = 20;
      }
      await this.persist();

      const auditId = envelope.commandId || crypto.randomUUID();
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
          'pending',
        )
        .run();

      recent.push(now);
      await this.state.storage.put(writesKey, recent);

      return new Response(
        JSON.stringify({ result: 'accepted', desired: applied, clamped: clamped ?? {}, issuedAt, writeId: auditId }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    if (request.method === 'POST' && url.pathname === '/command/ack') {
      const body = (await request.json().catch(() => null)) as {
        commandId?: string;
        status?: 'applied' | 'failed' | 'expired';
        details?: string;
        ackAt?: string;
      } | null;
      if (!body || typeof body.commandId !== 'string' || !body.commandId) {
        return new Response(JSON.stringify({ error: 'invalid_command_id' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      const snapshot = this.snapshot.commands.find((cmd) => cmd.id === body.commandId);
      if (snapshot) {
        const status = body.status ?? snapshot.status;
        const ackAt =
          typeof body.ackAt === 'string' && body.ackAt.length > 0 ? body.ackAt : new Date().toISOString();
        snapshot.status = status;
        snapshot.ack = {
          status,
          ts: ackAt,
          ...(typeof body.details === 'string' && body.details.length > 0
            ? { details: body.details }
            : {}),
        };
        await this.persist();
      }
      return new Response(null, { status: 204 });
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
      while (this.baseline.buf.length) {
        const head = this.baseline.buf[0];
        if (!head || head.t >= cutoff) {
          break;
        }
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

export class DeviceSQLiteDO {
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

      const loggedDeviceId =
        payload && typeof (payload as Record<string, unknown>).deviceId === 'string'
          ? ((payload as Record<string, unknown>).deviceId as string)
          : this.state.id.toString();

      await this.env.DB.prepare(
        "INSERT INTO audit_log (id, ts, subject, device_id, action, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), nowISO, subject, loggedDeviceId, 'command', JSON.stringify(payload))
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
