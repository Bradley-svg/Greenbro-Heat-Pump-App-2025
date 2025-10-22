import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import { useAuthFetch } from '@hooks/useAuthFetch';
import type { OverviewSummary } from '@api/types';

export function OverviewPage(): JSX.Element {
  const authFetch = useAuthFetch();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['overview'],
    queryFn: () => apiFetch<OverviewSummary>('/api/devices/summary', undefined, authFetch),
    refetchInterval: 30_000,
  });

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Fleet overview</h2>
          <p className="page__subtitle">Live rollup of device health and alerts</p>
        </div>
        <span className="page__updated">Updated {data ? new Date(data.updatedAt).toLocaleTimeString() : '—'}</span>
      </header>
      {isLoading ? (
        <div className="card">Loading overview…</div>
      ) : isError ? (
        <div className="card card--error">Failed to load overview. Check your API connection.</div>
      ) : data ? (
        <>
          <section className="metric-grid">
            <MetricCard label="Total devices" value={data.totalDevices} />
            <MetricCard label="Online" value={data.online} tone="positive" />
            <MetricCard label="Offline" value={data.offline} tone={data.offline > 0 ? 'negative' : 'neutral'} />
            <MetricCard label="Commissioning" value={data.commissioning} />
            <MetricCard label="Open alerts" value={data.alertsOpen} tone={data.alertsOpen > 0 ? 'warning' : 'neutral'} />
          </section>
          {data.topClients && data.topClients.length > 0 ? (
            <section className="card">
              <h3>Top client sites</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Devices</th>
                    <th>Location</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topClients.map((client) => (
                    <tr key={client.clientId}>
                      <td>{client.clientId}</td>
                      <td>{client.devices}</td>
                      <td>{client.location ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

interface MetricCardProps {
  label: string;
  value: number;
  tone?: 'neutral' | 'positive' | 'negative' | 'warning';
}

function MetricCard({ label, value, tone = 'neutral' }: MetricCardProps): JSX.Element {
  return (
    <div className={`card metric-card metric-card--${tone}`}>
      <span className="metric-card__label">{label}</span>
      <span className="metric-card__value">{value}</span>
    </div>
  );
}
