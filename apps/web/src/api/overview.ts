import { apiFetch } from './client';
import type { OverviewKpis, OverviewSparklineResponse } from './types';

export function getOverviewKpis(fetchImpl?: typeof fetch) {
  return apiFetch<OverviewKpis>('/api/overview/kpis', undefined, fetchImpl);
}

export function getOverviewSparklines(fetchImpl?: typeof fetch) {
  return apiFetch<OverviewSparklineResponse>('/api/overview/sparklines', undefined, fetchImpl);
}
