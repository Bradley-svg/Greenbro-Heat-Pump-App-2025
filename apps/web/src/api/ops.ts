import { apiFetch } from './client';
import type { OpsSloSummary } from './types';

export function getOpsSlo() {
  return apiFetch<OpsSloSummary[]>('/api/ops/slo');
}
