import type { Alert } from './types';
import { authFetch } from './client';

export async function listAlerts(params: { severity?: string; state?: string; device_id?: string } = {}) {
  const q = new URLSearchParams(params as Record<string, string>).toString();
  const r = await authFetch(`/api/alerts${q ? `?${q}` : ''}`);
  return (await r.json()) as Alert[];
}
export async function ackAlert(id: string) {
  const r = await authFetch(`/api/alerts/${id}/ack`, { method: 'POST' });
  if (!r.ok) throw new Error(await r.text());
}
