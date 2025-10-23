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

export interface ArchivePresetDefinition {
  id: string;
  name: string;
  cols: string[];
}

export interface ArchivePresetsResponse {
  presets?: ArchivePresetDefinition[] | null;
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

function normalisePresetEntry(entry: unknown): ArchivePresetDefinition | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const idRaw = record.id;
  const nameRaw = record.name;
  const colsRaw = (record.cols ?? record.columns) as unknown;

  const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : undefined;
  const id = typeof idRaw === 'string' && idRaw.trim() ? idRaw.trim() : name;
  if (!id) {
    return null;
  }
  const columns = Array.isArray(colsRaw)
    ? colsRaw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  if (!columns.length) {
    return null;
  }

  return {
    id,
    name: name ?? id,
    cols: columns,
  } satisfies ArchivePresetDefinition;
}

export async function fetchArchivePresets(
  table: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ArchivePresetDefinition[]> {
  const params = new URLSearchParams({ table });
  const response = await apiFetch<ArchivePresetsResponse | ArchivePresetDefinition[]>(
    `/api/admin/archive/presets?${params.toString()}`,
    undefined,
    fetchImpl,
  );

  const raw = Array.isArray(response) ? response : response?.presets ?? [];
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => normalisePresetEntry(entry))
    .filter((preset): preset is ArchivePresetDefinition => Boolean(preset));
}
