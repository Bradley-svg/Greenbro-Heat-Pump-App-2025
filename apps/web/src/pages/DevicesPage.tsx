import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import { useAuthFetch } from '@hooks/useAuthFetch';
import type { Device } from '@api/types';

export function DevicesPage(): JSX.Element {
  const authFetch = useAuthFetch();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['devices'],
    queryFn: () => apiFetch<Device[]>('/api/devices', undefined, authFetch),
    refetchInterval: 20_000,
  });

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Devices</h2>
          <p className="page__subtitle">Browse inventory and jump into live telemetry</p>
        </div>
      </header>
      {isLoading ? (
        <div className="card">Loading devices…</div>
      ) : isError ? (
        <div className="card card--error">Unable to load devices. Check your API connection.</div>
      ) : data && data.length > 0 ? (
        <section className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Status</th>
                <th>Site</th>
                <th>Last heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {data.map((device) => (
                <tr key={device.id}>
                  <td>
                    <Link to={`/devices/${device.id}`} className="inline-link">
                      {device.name}
                    </Link>
                    {device.serialNumber ? <div className="data-table__muted">SN {device.serialNumber}</div> : null}
                  </td>
                  <td>
                    <StatusPill status={device.status} />
                  </td>
                  <td>{device.site?.name ?? '—'}</td>
                  <td>{device.lastHeartbeat ? new Date(device.lastHeartbeat).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <div className="card">No devices available yet.</div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: Device['status'] }): JSX.Element {
  const tone = status === 'online' ? 'positive' : status === 'offline' ? 'negative' : 'neutral';
  return <span className={`status-pill status-pill--${tone}`}>{status}</span>;
}
