import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import type { OpsSloSummary } from '@api/types';
import { useAuthFetch } from '@hooks/useAuthFetch';

export function OpsPage(): JSX.Element {
  const authFetch = useAuthFetch();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['ops', 'slo'],
    queryFn: () => apiFetch<OpsSloSummary[]>('/api/ops/slo', undefined, authFetch),
    refetchInterval: 60_000,
  });

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Operations</h2>
          <p className="page__subtitle">Live burn rates and SLOs from your Worker</p>
        </div>
      </header>
      {isLoading ? (
        <div className="card">Loading SLOs…</div>
      ) : isError ? (
        <div className="card card--error">Failed to load SLO feed. Check the Worker endpoint.</div>
      ) : data && data.length > 0 ? (
        <section className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>SLO</th>
                <th>Window</th>
                <th>Burn rate</th>
                <th>Status</th>
                <th>Target</th>
                <th>Current</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={`${row.slo}-${row.window}`}>
                  <td>{row.slo}</td>
                  <td>{row.window}</td>
                  <td>{row.burnRate.toFixed(2)}</td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td>{row.target}</td>
                  <td>{row.currentValue.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <div className="card">No SLO definitions yet.</div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: OpsSloSummary['status'] }): JSX.Element {
  const tone = status === 'ok' ? 'positive' : status === 'violated' ? 'negative' : 'warning';
  return <span className={`status-pill status-pill--${tone}`}>{status}</span>;
}
