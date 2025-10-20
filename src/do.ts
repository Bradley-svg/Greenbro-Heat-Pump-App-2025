import type { TelemetryPayload } from './types';

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
  private snapshot: DeviceStateSnapshot = { commands: [] };
  private readonly ready: Promise<void>;

  constructor(state: DurableObjectState) {
    this.state = state;
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

    if (request.method === 'POST' && url.pathname === '/telemetry') {
      const body = (await request.json()) as TelemetrySnapshot;
      this.snapshot.telemetry = body;
      await this.persist();
      return new Response(null, { status: 204 });
    }

    if (request.method === 'POST' && url.pathname === '/heartbeat') {
      const body = (await request.json()) as HeartbeatSnapshot;
      this.snapshot.heartbeat = body;
      await this.persist();
      return new Response(null, { status: 204 });
    }

    if (request.method === 'POST' && url.pathname === '/command') {
      const envelope = (await request.json()) as CommandEnvelope;
      const issuedAt = new Date().toISOString();
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
      return new Response(
        JSON.stringify({ status: 'accepted', issuedAt, applied, clamped: clamped ?? null }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
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
