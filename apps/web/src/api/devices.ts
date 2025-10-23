import { authFetch } from './client';
import type { Device, DeviceLatestState, TelemetryPoint } from './types';

export async function getDevices() {
  const res = await authFetch('/api/devices');
  if (!res.ok) throw res;
  return (await res.json()) as Device[];
}

export async function getDeviceLatest(deviceId: string) {
  const res = await authFetch(`/api/devices/${deviceId}/latest`);
  if (!res.ok) throw res;
  return (await res.json()) as DeviceLatestState;
}

export async function getDeviceTelemetry(deviceId: string, range: '24h' | '7d') {
  const params = new URLSearchParams({ range });
  const res = await authFetch(`/api/devices/${deviceId}/series?${params.toString()}`);
  if (!res.ok) throw res;
  return (await res.json()) as TelemetryPoint[];
}
