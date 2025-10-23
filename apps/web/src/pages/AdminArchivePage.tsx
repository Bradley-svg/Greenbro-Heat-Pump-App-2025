import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchArchiveLogs,
  fetchArchivePresets,
  type ArchivePresetDefinition,
  type ArchiveResponse,
  type ArchiveRow,
} from '@api/admin';
import { resolveApiUrl } from '@api/client';
import { useAuthFetch } from '@hooks/useAuthFetch';

const TABLE_KEYS = ['telemetry', 'alerts', 'incidents'] as const;
type ArchiveTableKey = (typeof TABLE_KEYS)[number];

type ColumnDefinition = {
  name: string;
  label: string;
  description?: string;
};

type Preset = {
  id: string;
  name: string;
  columns: string[];
};

type SelectionMap = Record<ArchiveTableKey, string[]>;

type ArchiveFormat = 'ndjson' | 'csv';

const GZIP_LEVEL_STORAGE_KEY = 'greenbro-archive-gz-level';
const STAGE_STORAGE_KEY = 'greenbro-archive-stage';
const DEFAULT_GZIP_LEVEL = 6;

const COLUMN_SCHEMAS: Record<ArchiveTableKey, ColumnDefinition[]> = {
  telemetry: [
    { name: 'ts', label: 'Timestamp' },
    { name: 'device_id', label: 'Device ID' },
    { name: 'site_id', label: 'Site ID' },
    { name: 'delta_t', label: 'ΔT (°C)' },
    { name: 'cop', label: 'COP' },
    { name: 'kW_el', label: 'kW (electrical)' },
    { name: 'kW_th', label: 'kW (thermal)' },
    { name: 'metrics_json', label: 'Metrics JSON' },
    { name: 'status', label: 'Status JSON' },
    { name: 'faults_json', label: 'Faults JSON' },
    { name: 'cop_quality', label: 'COP quality' },
  ],
  alerts: [
    { name: 'alert_id', label: 'Alert ID' },
    { name: 'device_id', label: 'Device ID' },
    { name: 'site_id', label: 'Site ID' },
    { name: 'type', label: 'Type' },
    { name: 'severity', label: 'Severity' },
    { name: 'state', label: 'State' },
    { name: 'opened_at', label: 'Opened at' },
    { name: 'closed_at', label: 'Closed at' },
    { name: 'acknowledged_at', label: 'Acknowledged at' },
    { name: 'meta_json', label: 'Metadata JSON' },
  ],
  incidents: [
    { name: 'incident_id', label: 'Incident ID' },
    { name: 'site_id', label: 'Site ID' },
    { name: 'opened_at', label: 'Opened at' },
    { name: 'closed_at', label: 'Closed at' },
    { name: 'last_alert_at', label: 'Last alert at' },
    { name: 'root_cause', label: 'Root cause' },
    { name: 'severity', label: 'Severity' },
    { name: 'state', label: 'State' },
    { name: 'meta_json', label: 'Metadata JSON' },
  ],
};

const FALLBACK_COLUMN_PRESETS: Record<ArchiveTableKey, Preset[]> = {
  telemetry: [
    { id: 'minimal', name: 'Minimal', columns: ['ts', 'device_id', 'delta_t', 'cop'] },
    {
      id: 'diagnostics',
      name: 'Diagnostics',
      columns: ['ts', 'device_id', 'delta_t', 'cop', 'metrics_json', 'status', 'faults_json'],
    },
    { id: 'power', name: 'Power', columns: ['ts', 'device_id', 'cop', 'kW_el', 'kW_th'] },
  ],
  alerts: [
    { id: 'triage', name: 'Triage', columns: ['opened_at', 'closed_at', 'device_id', 'type', 'severity', 'state'] },
    {
      id: 'full',
      name: 'Full',
      columns: ['opened_at', 'closed_at', 'device_id', 'type', 'severity', 'state', 'meta_json'],
    },
  ],
  incidents: [
    { id: 'summary', name: 'Summary', columns: ['opened_at', 'closed_at', 'site_id', 'root_cause', 'severity', 'state'] },
  ],
};

const DEFAULTS_KEY_PREFIX = 'greenbro-archive-default-';

function readDefaultColumns(table: ArchiveTableKey): string[] | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(`${DEFAULTS_KEY_PREFIX}${table}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const allowed = new Set(COLUMN_SCHEMAS[table].map((column) => column.name));
    const filtered = (parsed as unknown[]).filter((item): item is string => typeof item === 'string' && allowed.has(item));
    return filtered.length ? filtered : null;
  } catch (error) {
    console.warn('Failed to read stored archive defaults', error);
    return null;
  }
}

function writeDefaultColumns(table: ArchiveTableKey, columns: string[]): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const allowed = new Set(COLUMN_SCHEMAS[table].map((column) => column.name));
    const filtered = columns.filter((column) => allowed.has(column));
    window.localStorage.setItem(`${DEFAULTS_KEY_PREFIX}${table}`, JSON.stringify(filtered));
  } catch (error) {
    console.warn('Failed to persist archive defaults', error);
  }
}

function computeInitialSelections(): SelectionMap {
  const entries = {} as SelectionMap;
  for (const table of TABLE_KEYS) {
    const stored = readDefaultColumns(table);
    if (stored && stored.length) {
      entries[table] = normaliseColumns(table, stored);
    } else {
      entries[table] = COLUMN_SCHEMAS[table].map((column) => column.name);
    }
  }
  return entries;
}

function normaliseColumns(table: ArchiveTableKey, columns: string[]): string[] {
  const order = COLUMN_SCHEMAS[table].map((column) => column.name);
  const unique = new Set(columns);
  return order.filter((column) => unique.has(column));
}

function clampGzipLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return DEFAULT_GZIP_LEVEL;
  }
  return Math.min(9, Math.max(1, Math.round(level)));
}

function getDefaultStageEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.localStorage.getItem(STAGE_STORAGE_KEY) === '1';
}

function getDefaultGzipLevel(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_GZIP_LEVEL;
  }
  const raw = window.localStorage.getItem(GZIP_LEVEL_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_GZIP_LEVEL;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_GZIP_LEVEL;
  }
  return clampGzipLevel(parsed);
}

function getYesterdayIso(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 'KB';
  for (const candidate of units) {
    size /= 1024;
    unit = candidate;
    if (size < 1024) {
      break;
    }
  }
  const digits = size >= 10 ? 0 : 1;
  return `${size.toFixed(digits)} ${unit}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return '—';
  }
  try {
    const iso = new Date(value).toISOString();
    return iso.replace('T', ' ').replace('.000Z', 'Z');
  } catch (error) {
    console.warn('Failed to format timestamp', error);
    return value;
  }
}

function buildDownloadHref(
  row: ArchiveRow,
  gzipEnabled: boolean,
  gzipLevel: number,
  stageEnabled: boolean,
): string {
  const params = new URLSearchParams({ key: row.key });
  if (gzipEnabled) {
    params.set('gz', '1');
    params.set('gzl', String(gzipLevel));
  }
  if (stageEnabled) {
    params.set('stage', '1');
  }
  return resolveApiUrl(`/api/admin/archive/download?${params.toString()}`);
}

function buildOnDemandHref(
  table: ArchiveTableKey,
  columns: string[],
  format: ArchiveFormat,
  gzipEnabled: boolean,
  gzipLevel: number,
  stageEnabled: boolean,
): string {
  const params = new URLSearchParams({ table, format });
  if (columns.length) {
    params.set('columns', columns.join(','));
  }
  if (gzipEnabled) {
    params.set('gz', '1');
    params.set('gzl', String(gzipLevel));
  }
  if (stageEnabled) {
    params.set('stage', '1');
  }
  return resolveApiUrl(`/api/admin/archive/export?${params.toString()}`);
}

function buildDownloadName(table: ArchiveTableKey, format: ArchiveFormat, gzipEnabled: boolean): string {
  const base = `${table}-export.${format}`;
  return gzipEnabled ? `${base}.gz` : base;
}

export function AdminArchivePage(): JSX.Element {
  const authFetch = useAuthFetch();
  const [selectedDate, setSelectedDate] = useState<string>(() => getYesterdayIso());
  const [selectedTable, setSelectedTable] = useState<ArchiveTableKey>('telemetry');
  const [stageEnabled, setStageEnabled] = useState<boolean>(() => getDefaultStageEnabled());
  const [gzipEnabled, setGzipEnabled] = useState<boolean>(true);
  const [gzipLevel, setGzipLevel] = useState<number>(() => getDefaultGzipLevel());
  const [selections, setSelections] = useState<SelectionMap>(() => computeInitialSelections());

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STAGE_STORAGE_KEY, stageEnabled ? '1' : '0');
    }
  }, [stageEnabled]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(GZIP_LEVEL_STORAGE_KEY, String(gzipLevel));
    }
  }, [gzipLevel]);

  const archiveQuery = useQuery<ArchiveResponse>({
    queryKey: ['admin-archive', selectedDate],
    queryFn: () => fetchArchiveLogs(selectedDate, authFetch),
  });

  const presetsQuery = useQuery<ArchivePresetDefinition[]>({
    queryKey: ['admin-archive-presets', selectedTable],
    queryFn: () => fetchArchivePresets(selectedTable, authFetch),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const schema = COLUMN_SCHEMAS[selectedTable];
  const selectedColumns = selections[selectedTable] ?? [];
  const allowed = new Set(schema.map((column) => column.name));
  const validColumns = selectedColumns.filter((column) => allowed.has(column));

  useEffect(() => {
    if (!selections[selectedTable]) {
      setSelections((previous) => ({
        ...previous,
        [selectedTable]: COLUMN_SCHEMAS[selectedTable].map((column) => column.name),
      }));
    }
  }, [selectedTable, selections]);

  const onToggleColumn = (column: string) => {
    setSelections((previous) => {
      const current = previous[selectedTable] ?? [];
      const nextSet = new Set(current);
      if (nextSet.has(column)) {
        nextSet.delete(column);
      } else {
        nextSet.add(column);
      }
      const normalised = normaliseColumns(selectedTable, Array.from(nextSet));
      return { ...previous, [selectedTable]: normalised };
    });
  };

  const applyPreset = (presetColumns: string[]) => {
    setSelections((previous) => ({
      ...previous,
      [selectedTable]: normaliseColumns(selectedTable, presetColumns),
    }));
  };

  const selectAll = () => {
    setSelections((previous) => ({
      ...previous,
      [selectedTable]: schema.map((column) => column.name),
    }));
  };

  const saveDefault = () => {
    writeDefaultColumns(selectedTable, selections[selectedTable] ?? []);
  };

  const archiveRows = archiveQuery.data?.results ?? [];
  const totalExports = archiveRows.length;
  const totalBytes = archiveRows.reduce((sum, row) => sum + (Number.isFinite(row.size) ? row.size : 0), 0);
  const maxDate = new Date().toISOString().slice(0, 10);

  const builderDisabled = validColumns.length === 0;
  const presets = useMemo<Preset[]>(() => {
    const serverPresets = (presetsQuery.data ?? [])
      .map((preset) => ({
        id: preset.id,
        name: preset.name,
        columns: normaliseColumns(selectedTable, preset.cols),
      }))
      .filter((preset) => preset.columns.length > 0);

    if (serverPresets.length > 0) {
      return serverPresets;
    }

    return FALLBACK_COLUMN_PRESETS[selectedTable].map((preset) => ({
      id: preset.id,
      name: preset.name,
      columns: normaliseColumns(selectedTable, preset.columns),
    }));
  }, [presetsQuery.data, selectedTable]);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Archive exports</h2>
          <p className="page__subtitle">Download telemetry, alerts, and incidents for long-term storage</p>
        </div>
      </header>

      <section className="card" style={{ display: 'grid', gap: 16 }}>
        <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>On-demand export builder</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label className="data-table__muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={stageEnabled}
                onChange={(event) => setStageEnabled(event.target.checked)}
              />
              Stage (Content-Length)
            </label>
            <label className="data-table__muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={gzipEnabled}
                onChange={(event) => setGzipEnabled(event.target.checked)}
              />
              Gzip output
            </label>
            <label className="data-table__muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Level
              <select
                value={gzipLevel}
                onChange={(event) => setGzipLevel(clampGzipLevel(Number(event.target.value)))}
                disabled={!gzipEnabled}
              >
                <option value={1}>Fast — 1</option>
                <option value={6}>Balanced — 6</option>
                <option value={9}>Max — 9</option>
              </select>
            </label>
          </div>
        </header>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            Table
            <select value={selectedTable} onChange={(event) => setSelectedTable(event.target.value as ArchiveTableKey)}>
              <option value="telemetry">Telemetry</option>
              <option value="alerts">Alerts</option>
              <option value="incidents">Incidents</option>
            </select>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="data-table__muted">Presets</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="app-button app-button--secondary"
                  onClick={() => applyPreset(preset.columns)}
                >
                  {preset.name}
                </button>
              ))}
              <button type="button" className="app-button app-button--ghost" onClick={selectAll}>
                Select all
              </button>
            </div>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>Columns</strong>
            <div className="data-table__muted">{validColumns.length} of {schema.length} selected</div>
          </div>
          <div className="chip-grid" style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            {schema.map((column) => {
              const checked = validColumns.includes(column.name);
              return (
                <label
                  key={column.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    border: '1px solid #d1d5db',
                    borderRadius: 8,
                    background: checked ? 'rgba(15, 118, 110, 0.08)' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleColumn(column.name)}
                  />
                  <span>
                    <span style={{ display: 'block', fontWeight: 500 }}>{column.label}</span>
                    {column.description ? (
                      <span className="data-table__muted" style={{ fontSize: 12 }}>{column.description}</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <a
            className="app-button"
            style={builderDisabled ? { pointerEvents: 'none', opacity: 0.6 } : undefined}
            href={
              builderDisabled
                ? undefined
                : buildOnDemandHref(selectedTable, validColumns, 'ndjson', gzipEnabled, gzipLevel, stageEnabled)
            }
            download={buildDownloadName(selectedTable, 'ndjson', gzipEnabled)}
            aria-disabled={builderDisabled}
            onClick={(event) => {
              if (builderDisabled) {
                event.preventDefault();
              }
            }}
          >
            Download NDJSON
          </a>
          <a
            className="app-button"
            style={builderDisabled ? { pointerEvents: 'none', opacity: 0.6 } : undefined}
            href={
              builderDisabled
                ? undefined
                : buildOnDemandHref(selectedTable, validColumns, 'csv', gzipEnabled, gzipLevel, stageEnabled)
            }
            download={buildDownloadName(selectedTable, 'csv', gzipEnabled)}
            aria-disabled={builderDisabled}
            onClick={(event) => {
              if (builderDisabled) {
                event.preventDefault();
              }
            }}
          >
            Download CSV
          </a>
          <button type="button" className="app-button app-button--secondary" onClick={saveDefault}>
            Save as default for this table
          </button>
        </div>
      </section>

      <section className="card" style={{ display: 'grid', gap: 16 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>Nightly archives</h3>
          <label className="data-table__muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            Date
            <input
              type="date"
              max={maxDate}
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          </label>
        </header>
        {archiveQuery.isLoading ? (
          <div>Loading exports…</div>
        ) : archiveQuery.isError ? (
          <div className="card card--error">Failed to load archive exports.</div>
        ) : totalExports === 0 ? (
          <p className="data-table__muted">No exports recorded for {selectedDate}.</p>
        ) : (
          <>
            <p className="data-table__muted">
              {totalExports} exports · Total {formatSize(totalBytes)}
            </p>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th>Rows</th>
                    <th>Size</th>
                    <th>Key</th>
                    <th>Exported</th>
                    <th>Download</th>
                  </tr>
                </thead>
                <tbody>
                  {archiveRows.map((row) => (
                    <tr key={row.key}>
                      <td>{row.table}</td>
                      <td>{Number.isFinite(row.rows) ? row.rows.toLocaleString() : row.rows}</td>
                      <td>{formatSize(row.size)}</td>
                      <td>
                        <code>{row.key}</code>
                      </td>
                      <td>{formatTimestamp(row.exportedAt)}</td>
                      <td>
                        <a
                          className="app-button"
                          href={buildDownloadHref(row, gzipEnabled, gzipLevel, stageEnabled)}
                        >
                          Download
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
