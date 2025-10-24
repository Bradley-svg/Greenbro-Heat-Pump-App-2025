import type { Role } from '@utils/types';

export interface DeviceSiteMeta {
  id?: string;
  name: string;
  location?: string;
  region?: string;
  lat?: number;
  lon?: number;
}

export interface Device {
  id: string;
  name: string;
  serialNumber?: string;
  siteId?: string;
  region?: string;
  site?: DeviceSiteMeta;
  status: 'online' | 'offline' | 'commissioning' | 'maintenance';
  lastHeartbeat?: string;
  clientIds?: string[];
}

export interface DeviceLatestState {
  deviceId: string;
  timestamp: string;
  metrics: Record<string, number | null>;
  status: {
    mode?: string;
    defrost?: boolean;
    online?: boolean;
    flags?: Record<string, Record<string, boolean>>;
  };
  faults?: Array<{ code: string; description?: string; active: boolean }>;
}

export interface TelemetryPoint {
  timestamp: string;
  metrics: Record<string, number | null>;
}

export interface OverviewKpis {
  online_pct: number;
  open_alerts: number;
  avg_cop: number;
  low_dt: number;
  updated_at?: string;
}

export interface OverviewSparklineResponse {
  cop: number[];
  delta_t: number[];
}

export interface SiteSummary {
  siteId: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  online: boolean;
  health?: 'good' | 'warning' | 'critical' | 'unknown';
}

export interface OverviewSummary {
  totalDevices: number;
  online: number;
  offline: number;
  alertsOpen: number;
  commissioning: number;
  updatedAt: string;
  topClients?: Array<{ clientId: string; devices: number; location?: string }>;
}

export interface Alert {
  id: string;
  deviceId: string;
  title: string;
  description?: string;
  severity: 'info' | 'warning' | 'critical';
  state: 'open' | 'acknowledged' | 'closed';
  createdAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  type?: string;
  coverage?: number | null;
  drift?: number | null;
  meta?: {
    kind: string;
    coverage: number | null;
    drift: number | null;
    units: string;
    snoozed_until?: string | null;
  };
  summary?: string;
}

export interface AcknowledgeAlertInput {
  id: string;
}

export interface AcknowledgeAlertResponse {
  ok: boolean;
  alert?: Alert;
}

export interface OpsSloSummary {
  slo: string;
  window: string;
  burnRate: number;
  status: 'ok' | 'breaching' | 'violated';
  target: number;
  currentValue: number;
  updatedAt: string;
  owner?: Role;
  metadata?: Record<string, unknown>;
}

export interface OpsSloSnapshot {
  ingest_success_pct: number;
  heartbeat_freshness_pct: number;
  p95_ingest_latency_ms: number;
  burn: number;
  updated_at?: string;
  baselineDeviation?: { window: string; warning: number; critical: number };
}

export interface PublicSettings {
  readOnly: boolean;
  canToggle?: boolean;
}
