import { apiFetch } from './client';
import type { AcknowledgeAlertInput, AcknowledgeAlertResponse, Alert } from './types';

export function getAlerts() {
  return apiFetch<Alert[]>('/api/alerts');
}

export function acknowledgeAlert(input: AcknowledgeAlertInput) {
  return apiFetch<AcknowledgeAlertResponse>(`/api/alerts/${input.id}/ack`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
