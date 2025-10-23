import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '@api/client';
import type { AcknowledgeAlertResponse, Alert } from '@api/types';
import { useAuthFetch } from '@hooks/useAuthFetch';
import { useToast } from '@app/providers/ToastProvider';
import { useReadOnly } from '@hooks/useReadOnly';

function FocusIncidentsPill(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const active = params.get('severity') === 'critical' && params.get('state') === 'open';

  return (
    <button
      className={`pill${active ? ' is-active' : ''}`}
      type="button"
      onClick={() => {
        const next = new URLSearchParams(params);
        if (active) {
          next.delete('severity');
          next.delete('state');
        } else {
          next.set('severity', 'critical');
          next.set('state', 'open');
        }
        setParams(next, { replace: true });
      }}
    >
      Focus active incidents
    </button>
  );
}

export function AlertsPage(): JSX.Element {
  const authFetch = useAuthFetch();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { ro } = useReadOnly();
  const alertsQuery = useQuery({
    queryKey: ['alerts'],
    queryFn: () => apiFetch<Alert[]>('/api/alerts', undefined, authFetch),
    refetchInterval: 15_000,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<AcknowledgeAlertResponse>(`/api/alerts/${id}/ack`, { method: 'POST', body: JSON.stringify({}) }, authFetch),
    onMutate: async (id) => {
      if (ro) {
        throw new Error('Read-only mode is active');
      }
      await queryClient.cancelQueries({ queryKey: ['alerts'] });
      const previous = queryClient.getQueryData<Alert[]>(['alerts']);
      if (previous) {
        queryClient.setQueryData<Alert[]>(['alerts'], (alerts = []) =>
          alerts.map((alert) =>
            alert.id === id ? { ...alert, state: 'acknowledged', acknowledgedAt: new Date().toISOString() } : alert,
          ),
        );
      }
      return { prev: previous };
    },
    onError: (error, _id, context) => {
      if (context?.prev) {
        queryClient.setQueryData(['alerts'], context.prev);
      }
      const message = error instanceof Error ? error.message : String(error);
      toast.push(
        message.includes('Read-only')
          ? 'Read-only mode: writes are temporarily disabled.'
          : 'Failed to acknowledge alert.',
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
  });

  const alerts = alertsQuery.data ?? [];

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Alerts</h2>
          <p className="page__subtitle">Acknowledge incidents as you work the queue</p>
        </div>
        <FocusIncidentsPill />
      </header>
      {alertsQuery.isLoading ? (
        <div className="card">Loading alerts…</div>
      ) : alertsQuery.isError ? (
        <div className="card card--error">Failed to load alerts. Check your API.</div>
      ) : alerts.length === 0 ? (
        <div className="card">No active alerts 🎉</div>
      ) : (
        <ul className="alert-list">
          {alerts.map((alert) => (
            <li key={alert.id} className={`alert-card alert-card--${alert.severity}`}>
              <header>
                <span className="alert-card__title">{alert.title}</span>
                <span className="alert-card__timestamp">{new Date(alert.createdAt).toLocaleString()}</span>
              </header>
              <p className="alert-card__description">{alert.description ?? 'No description provided.'}</p>
              <footer className="alert-card__footer">
                <span className="alert-card__meta">Device {alert.deviceId}</span>
                {alert.state === 'acknowledged' ? (
                  <span className="alert-card__ack">Acked</span>
                ) : (
                  <button
                    className="app-button"
                    type="button"
                    onClick={() => acknowledgeMutation.mutate(alert.id)}
                    disabled={ro || acknowledgeMutation.isPending}
                  >
                    {ro ? 'Ack (disabled)' : 'Ack'}
                  </button>
                )}
              </footer>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
