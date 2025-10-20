export type Role = 'admin' | 'ops' | 'client' | 'contractor';

export interface Env {
  DB: D1Database;
  CONFIG: KVNamespace;
  REPORTS: R2Bucket;
  INGEST_QUEUE: Queue;

  DeviceState: DurableObjectNamespace;

  ACCESS_JWKS_URL: string;
  ACCESS_AUD: string;

  WRITE_MIN_C: string;
  WRITE_MAX_C: string;
}

export type TelemetryPayload = {
  deviceId: string;
  ts: string;
  metrics: {
    tankC?: number;
    supplyC?: number;
    returnC?: number;
    ambientC?: number;
    flowLps?: number;
    compCurrentA?: number;
    eevSteps?: number;
    powerKW?: number;
  };
  status?: {
    mode?: string;
    defrost?: boolean;
    online?: boolean;
  };
  faults?: Array<{ code: string; active: boolean }>;
  derived?: {
    deltaT?: number;
    thermalKW?: number;
    cop?: number;
    copQuality?: 'measured' | 'estimated';
  };
};

export type HeartbeatPayload = {
  deviceId: string;
  ts: string;
  rssi?: number;
};

export type IngestMessage =
  | { kind: 'telemetry'; profileId: string; body: TelemetryPayload }
  | { kind: 'heartbeat'; profileId: string; body: HeartbeatPayload };
