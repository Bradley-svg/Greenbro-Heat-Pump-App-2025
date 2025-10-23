import { apiFetch } from './client';

export interface ArchiveRow {
  table: string;
  rows: number;
  key: string;
  size: number;
  exportedAt: string | null;
}

export interface ArchiveResponse {
  date: string;
  results: ArchiveRow[];
}

export async function fetchArchiveLogs(
  date: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ArchiveResponse> {
  const params = new URLSearchParams();
  if (date) {
    params.set('date', date);
  }
  const suffix = params.size ? `?${params.toString()}` : '';
  return apiFetch<ArchiveResponse>(`/api/admin/archive${suffix}`, undefined, fetchImpl);
}
