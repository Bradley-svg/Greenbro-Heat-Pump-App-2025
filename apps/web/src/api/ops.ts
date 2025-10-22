import { apiFetch } from './client';
import type { OpsSloSnapshot } from './types';

export function getOpsSnapshot(fetchImpl?: typeof fetch) {
  return apiFetch<OpsSloSnapshot>('/api/ops/slo', undefined, fetchImpl);
}
