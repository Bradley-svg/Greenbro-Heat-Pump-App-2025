import type { Role } from '@utils/types';

export interface Device {
  id: string;
  name: string;
  serialNumber?: string;
  site?: {
    name: string;
    location?: string;
  };
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
  };
  faults?: Array<{ code: string; description?: string; active: boolean }>;
}

export interface TelemetryPoint {
  timestamp: string;
  metrics: Record<string, number | null>;
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
