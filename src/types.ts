export type Role = 'admin' | 'ops' | 'client' | 'contractor';

export interface Env {
  DB: D1Database;
  CONFIG: KVNamespace;
  REPORTS: R2Bucket;
  BRAND: R2Bucket;
  ARCHIVE: R2Bucket;
  INGEST_Q: Queue<IngestMessage>;

  DeviceState: DurableObjectNamespace;
  DEVICE_DO: DurableObjectNamespace;

  ACCESS_AUD: string;
  ACCESS_ISS: string;
  ACCESS_JWKS?: string;
  ACCESS_JWKS_URL?: string;
  JWT_SECRET: string;

  WRITE_MIN_C?: string;
  WRITE_MAX_C?: string;
  DEV_AUTH_BYPASS?: string;
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
  | { type: 'telemetry'; profileId: string; body: TelemetryPayload }
  | { type: 'heartbeat'; profileId: string; body: HeartbeatPayload };
