import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '@api/client';
import type { AcknowledgeAlertResponse, Alert } from '@api/types';
import { useAuthFetch } from '@hooks/useAuthFetch';
import { useToast } from '@app/providers/ToastProvider';
import { useReadOnly } from '@hooks/useReadOnly';

type AlertRow = {
  alert_id: string;
  device_id: string;
  type?: string | null;
  severity?: string | null;
  state?: string | null;
  opened_at?: string | null;
  closed_at?: string | null;
  ack_at?: string | null;
  ack_by?: string | null;
  title?: string | null;
  description?: string | null;
  meta_json?: string | null;
  coverage?: number | null;
  drift?: number | null;
};

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
    queryFn: async () => {
      const raw = await apiFetch<unknown>('/api/alerts', undefined, authFetch);
      const rows = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { results?: unknown[] })?.results)
          ? (raw as { results: unknown[] }).results
          : [];
      return rows.map((entry) => mapAlertRow(entry as Partial<AlertRow>));
    },
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
                <span className="alert-card__meta">{formatAlertMeta(alert)}</span>
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

function mapAlertRow(row: Partial<AlertRow>): Alert {
  const severityRaw = (row.severity ?? '').toLowerCase();
  const severity: Alert['severity'] =
    severityRaw === 'critical' ? 'critical' : severityRaw === 'major' || severityRaw === 'warning' ? 'warning' : 'info';

  const stateRaw = (row.state ?? '').toLowerCase();
  const state: Alert['state'] =
    stateRaw === 'ack' || stateRaw === 'acknowledged'
      ? 'acknowledged'
      : stateRaw === 'closed'
        ? 'closed'
        : 'open';

  const createdAt = row.opened_at ?? row.closed_at ?? new Date().toISOString();
  const id = row.alert_id ?? `${row.device_id ?? 'alert'}-${createdAt}`;
  const description = row.description ?? (row.type === 'baseline_deviation' ? 'Deviation from baseline coverage thresholds.' : undefined);
  const meta = parseMetaFromRow(row);

  return {
    id,
    deviceId: row.device_id ?? '—',
    title: row.title ?? formatAlertTitle(row.type),
    description,
    severity,
    state,
    createdAt,
    acknowledgedAt: row.ack_at ?? undefined,
    acknowledgedBy: row.ack_by ?? undefined,
    type: row.type ?? undefined,
    coverage: meta.coverage,
    drift: meta.drift,
  };
}

function formatAlertTitle(type?: string | null): string {
  if (!type) {
    return 'Alert';
  }
  return type
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseMetaFromRow(row: Partial<AlertRow>): { coverage: number | null; drift: number | null } {
  let coverage: number | null = typeof row.coverage === 'number' && Number.isFinite(row.coverage) ? row.coverage : null;
  let drift: number | null = typeof row.drift === 'number' && Number.isFinite(row.drift) ? row.drift : null;

  if ((coverage == null || !Number.isFinite(coverage)) || (drift == null || !Number.isFinite(drift))) {
    try {
      const meta = row.meta_json ? JSON.parse(row.meta_json) : null;
      if (meta) {
        if (coverage == null && typeof meta.coverage === 'number' && Number.isFinite(meta.coverage)) {
          coverage = meta.coverage;
        }
        if (drift == null && typeof meta.drift === 'number' && Number.isFinite(meta.drift)) {
          drift = meta.drift;
        }
      }
    } catch (error) {
      console.warn('failed to parse alert meta', error);
    }
  }

  coverage =
    coverage != null && Number.isFinite(coverage) ? Math.min(1, Math.max(0, coverage)) : null;

  drift = drift != null && Number.isFinite(drift) ? drift : null;

  return { coverage, drift };
}

function formatAlertMeta(alert: Alert): string {
  if (alert.type === 'baseline_deviation') {
    const parts: string[] = [];
    if (typeof alert.coverage === 'number' && Number.isFinite(alert.coverage)) {
      parts.push(`${Math.round(alert.coverage * 100)}% in-range`);
    }
    if (typeof alert.drift === 'number' && Number.isFinite(alert.drift)) {
      const signed = alert.drift >= 0 ? `+${alert.drift.toFixed(1)}` : alert.drift.toFixed(1);
      parts.push(`drift ${signed}°C`);
    }
    const detail = parts.length ? ` — ${parts.join('; ')}` : '';
    return `Baseline deviation${detail}`;
  }
  return `Device ${alert.deviceId}`;
}
