import { apiFetch } from './client';
import type { Device, DeviceLatestState, TelemetryPoint } from './types';

export function getDevices() {
  return apiFetch<Device[]>('/api/devices');
}

export function getDeviceLatest(deviceId: string) {
  return apiFetch<DeviceLatestState>(`/api/devices/${deviceId}/latest`);
}

export function getDeviceTelemetry(deviceId: string, range: '24h' | '7d') {
  const params = new URLSearchParams({ range });
  return apiFetch<TelemetryPoint[]>(`/api/devices/${deviceId}/series?${params.toString()}`);
}
