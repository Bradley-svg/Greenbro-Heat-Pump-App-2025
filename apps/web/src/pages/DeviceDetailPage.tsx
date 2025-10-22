import { useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import { useAuthFetch } from '@hooks/useAuthFetch';
import type { DeviceLatestState, TelemetryPoint } from '@api/types';

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
        ) : (
          <p>No telemetry points for the selected window.</p>
        )}
      </section>
    </div>
  );
}
