import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import { useAuthFetch } from '@hooks/useAuthFetch';
import type { Device } from '@api/types';

export function DevicesPage(): JSX.Element {
  const authFetch = useAuthFetch();
  const [params, setParams] = useSearchParams();
  const selectedSite = params.get('site');
  const selectedRegion = params.get('region');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['devices'],
    queryFn: () => apiFetch<Device[]>('/api/devices', undefined, authFetch),
    refetchInterval: 20_000,
  });

  const filteredDevices = useMemo(() => {
    if (!data) return [];
    return data.filter((device) => {
      const matchesSite = selectedSite
        ? device.siteId === selectedSite || device.site?.id === selectedSite
        : true;
      const matchesRegion = selectedRegion
        ? device.region === selectedRegion || device.site?.region === selectedRegion
        : true;
      return matchesSite && matchesRegion;
    });
  }, [data, selectedRegion, selectedSite]);

  const activeFilters = [
    selectedSite ? `Site ${selectedSite}` : null,
    selectedRegion ? `Region ${selectedRegion}` : null,
  ].filter(Boolean);

  const clearFilters = () => {
    params.delete('site');
    params.delete('region');
    setParams(params, { replace: true });
  };

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Devices</h2>
          <p className="page__subtitle">Browse inventory and jump into live telemetry</p>
        </div>
      </header>
      {activeFilters.length ? (
        <div className="card filter-banner">
          <span>Filters: {activeFilters.join(', ')}</span>
          <button type="button" className="app-button" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : null}
      {isLoading ? (
        <div className="card">Loading devices…</div>
      ) : isError ? (
        <div className="card card--error">Unable to load devices. Check your API connection.</div>
      ) : filteredDevices.length > 0 ? (
        <section className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Status</th>
                <th>Site</th>
                <th>Region</th>
                <th>Last heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.map((device) => (
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
                  <td>{device.site?.region ?? device.region ?? '—'}</td>
                  <td>{device.lastHeartbeat ? new Date(device.lastHeartbeat).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <div className="card">No devices match the current filters.</div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: Device['status'] }): JSX.Element {
  const tone = status === 'online' ? 'positive' : status === 'offline' ? 'negative' : 'neutral';
  return <span className={`status-pill status-pill--${tone}`}>{status}</span>;
}
