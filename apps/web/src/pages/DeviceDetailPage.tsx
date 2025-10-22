import { useMemo, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import { useAuthFetch } from '@hooks/useAuthFetch';
import type { DeviceLatestState, TelemetryPoint } from '@api/types';
import { Legend } from '@components/charts/Legend';
import { SeriesChart, type AlertWindow, type SeriesPoint } from '@components/charts/SeriesChart';

const TELEMETRY_RANGES: Array<'24h' | '7d'> = ['24h', '7d'];

export function DeviceDetailPage(): JSX.Element {
  const { deviceId } = useParams<{ deviceId: string }>();
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const authFetch = useAuthFetch();

  if (!deviceId) {
    return <Navigate to="/devices" replace />;
  }

  const latestQuery = useQuery({
    queryKey: ['device', deviceId, 'latest'],
    queryFn: () => apiFetch<DeviceLatestState>(`/api/devices/${deviceId}/latest`, undefined, authFetch),
    refetchInterval: 10_000,
  });

  const telemetryQuery = useQuery({
    queryKey: ['device', deviceId, 'telemetry', range],
    queryFn: () => apiFetch<TelemetryPoint[]>(`/api/devices/${deviceId}/series?range=${range}`, undefined, authFetch),
    enabled: !!deviceId,
    refetchInterval: range === '24h' ? 20_000 : 60_000,
  });

  const alertWindowsQuery = useQuery({
    queryKey: ['device', deviceId, 'alert-windows', range],
    queryFn: () => apiFetch(`/api/alerts?device_id=${deviceId}&range=${range}`, undefined, authFetch),
    enabled: !!deviceId,
    refetchInterval: range === '24h' ? 10_000 : 30_000,
  });

  const deltaSeries = useMemo<SeriesPoint[]>(() => {
    const points = telemetryQuery.data ?? [];
    return points
      .map((point) => {
        const rawValue =
          point.metrics?.delta_t ??
          point.metrics?.deltaT ??
          point.metrics?.['delta-t'] ??
          point.metrics?.['deltaT'];
        if (rawValue == null) {
          return null;
        }
        const value = Number(rawValue);
        const ts = Date.parse(point.timestamp);
        if (!Number.isFinite(value) || Number.isNaN(ts)) {
          return null;
        }
        return { ts, v: value } satisfies SeriesPoint;
      })
      .filter((entry): entry is SeriesPoint => Boolean(entry));
  }, [telemetryQuery.data]);

  const alertWindows = useMemo<AlertWindow[]>(() => {
    const now = Date.now();
    const raw = alertWindowsQuery.data as
      | Array<Record<string, unknown>>
      | { results?: Array<Record<string, unknown>> }
      | undefined;
    const collection = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.results)
        ? raw.results
        : [];

    return collection
      .map((entry: Record<string, unknown>) => {
        const openedAt = extractTimestamp(entry, ['opened_at', 'started_at', 'start']);
        const closedAt = extractTimestamp(entry, ['closed_at', 'ended_at', 'end']);
        const start = openedAt != null ? Date.parse(openedAt) : Number.NaN;
        const end = closedAt != null ? Date.parse(closedAt) : now;
        if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
          return null;
        }
        const severity = typeof entry.severity === 'string' ? entry.severity.toLowerCase() : '';
        const kind: AlertWindow['kind'] = severity === 'critical' ? 'crit' : 'warn';
        return { start, end, kind } satisfies AlertWindow;
      })
      .filter((window): window is AlertWindow => Boolean(window));
  }, [alertWindowsQuery.data]);

  const latest = latestQuery.data;

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Device {deviceId}</h2>
          <p className="page__subtitle">Live telemetry and state snapshot</p>
        </div>
        <div className="chip-group">
          {TELEMETRY_RANGES.map((option) => (
            <button
              key={option}
              className={`chip${range === option ? ' chip--active' : ''}`}
              onClick={() => setRange(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </header>
      <section className="grid grid--two">
        <div className="card">
          <h3>Current status</h3>
          {latestQuery.isLoading ? (
            <p>Loading latest state…</p>
          ) : latestQuery.isError ? (
            <p className="card__error">Unable to load device state.</p>
          ) : latest ? (
            <ul className="kv-list">
              <li>
                <span>Sampled</span>
                <span>{new Date(latest.timestamp).toLocaleString()}</span>
              </li>
              {Object.entries(latest.metrics).map(([metric, value]) => (
                <li key={metric}>
                  <span>{metric}</span>
                  <span>{value ?? '—'}</span>
                </li>
              ))}
              {latest.status.mode ? (
                <li>
                  <span>Mode</span>
                  <span>{latest.status.mode}</span>
                </li>
              ) : null}
              <li>
                <span>Online</span>
                <span>{latest.status.online === false ? 'Offline' : 'Online'}</span>
              </li>
            </ul>
          ) : (
            <p>No telemetry yet.</p>
          )}
        </div>
        <div className="card">
          <h3>Active faults</h3>
          {latest?.faults && latest.faults.length > 0 ? (
            <ul className="fault-list">
              {latest.faults.map((fault) => (
                <li key={fault.code} className={fault.active ? 'fault fault--active' : 'fault'}>
                  <span className="fault__code">{fault.code}</span>
                  <span className="fault__description">{fault.description ?? 'No description'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No active faults.</p>
          )}
        </div>
      </section>
      <section className="card">
        <h3>Telemetry ({range})</h3>
        {telemetryQuery.isLoading ? (
          <p>Loading telemetry…</p>
        ) : telemetryQuery.isError ? (
          <p className="card__error">Unable to load telemetry.</p>
        ) : telemetryQuery.data && telemetryQuery.data.length > 0 ? (
          <>
            {deltaSeries.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
                <Legend
                  items={[
                    { kind: 'ok', label: 'ΔT trend' },
                    { kind: 'warn', label: 'Warning window' },
                    { kind: 'crit', label: 'Critical window' },
                  ]}
                  ariaLabel="ΔT alert legend"
                />
                <SeriesChart
                  data={deltaSeries}
                  overlays={alertWindows}
                  width={720}
                  height={240}
                  areaKind="ok"
                  ariaLabel="Delta temperature trend with alert overlays"
                />
              </div>
            ) : null}
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Metrics</th>
                </tr>
              </thead>
              <tbody>
                {telemetryQuery.data.slice(0, 20).map((point) => (
                  <tr key={point.timestamp}>
                    <td>{new Date(point.timestamp).toLocaleString()}</td>
                    <td>
                      <div className="kv-inline">
                        {Object.entries(point.metrics).map(([key, value]) => (
                          <span key={key}>
                            {key}: <strong>{value ?? '—'}</strong>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p>No telemetry points for the selected window.</p>
        )}
      </section>
    </div>
  );
}

function extractTimestamp(entry: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return undefined;
}
