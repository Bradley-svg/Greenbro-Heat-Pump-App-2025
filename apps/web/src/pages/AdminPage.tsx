import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import { useAuth } from '@app/providers/AuthProvider';
import { useToast } from '@app/providers/ToastProvider';
import { useAuthFetch } from '@hooks/useAuthFetch';
import { ROUTE_ROLES } from '@utils/rbac';
import type { Role } from '@utils/types';

type SettingRow = { key: string; value: string };

const BASELINE_FIELDS = [
  {
    key: 'baseline_cov_warn',
    label: 'Coverage warning threshold',
    help: 'Warn when the share of ΔT samples inside the golden IQR falls below this fraction.',
    step: 0.01,
    min: 0,
    max: 1,
  },
  {
    key: 'baseline_cov_crit',
    label: 'Coverage critical threshold',
    help: 'Escalate to critical when coverage drops under this fraction.',
    step: 0.01,
    min: 0,
    max: 1,
  },
  {
    key: 'baseline_drift_warn',
    label: 'Median drift warning (°C)',
    help: 'Warn when the rolling median deviates from baseline by this many °C.',
    step: 0.1,
    min: 0,
    max: undefined,
  },
  {
    key: 'baseline_drift_crit',
    label: 'Median drift critical (°C)',
    help: 'Critical alert when drift meets or exceeds this value.',
    step: 0.1,
    min: 0,
    max: undefined,
  },
  {
    key: 'baseline_dwell_s',
    label: 'Dwell (seconds)',
    help: 'Duration the deviation must persist before opening an alert.',
    step: 1,
    min: 0,
    max: undefined,
  },
] as const;

export function AdminPage(): JSX.Element {
  const { user, refresh, logout } = useAuth();
  const toast = useToast();
  const authFetch = useAuthFetch();
  const [baselineValues, setBaselineValues] = useState<Record<string, string>>({});

  const settingsQuery = useQuery({
    queryKey: ['admin:settings'],
    queryFn: () => apiFetch<SettingRow[]>('/api/admin/settings', undefined, authFetch),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }
    setBaselineValues((prev) => {
      const next = { ...prev };
      for (const row of settingsQuery.data ?? []) {
        if (BASELINE_FIELDS.some((field) => field.key === row.key)) {
          next[row.key] = row.value ?? '';
        }
      }
      return next;
    });
  }, [settingsQuery.data]);

  const updateSetting = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      await apiFetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      }, authFetch);
    },
    onSuccess: () => {
      toast.push('Setting saved.');
      void settingsQuery.refetch();
    },
    onError: (error) => {
      console.error('Failed to update setting', error);
      toast.push('Failed to save setting.');
    },
  });

  const savingKey = updateSetting.variables?.key ?? null;

  const handleSave = (key: string) => {
    const raw = baselineValues[key];
    if (raw == null) {
      return;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    updateSetting.mutate({ key, value: trimmed });
  };

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Admin</h2>
          <p className="page__subtitle">Review session state and RBAC</p>
        </div>
      </header>
      <section className="card">
        <h3>Current user</h3>
        {user ? (
          <ul className="kv-list">
            <li>
              <span>Email</span>
              <span>{user.email}</span>
            </li>
            {user.name ? (
              <li>
                <span>Name</span>
                <span>{user.name}</span>
              </li>
            ) : null}
            <li>
              <span>Roles</span>
              <span>{user.roles.join(', ')}</span>
            </li>
            {user.clientIds ? (
              <li>
                <span>Clients</span>
                <span>{user.clientIds.join(', ')}</span>
              </li>
            ) : null}
          </ul>
        ) : (
          <p>No user loaded.</p>
        )}
        <div className="button-row">
          <button className="app-button" type="button" onClick={() => void refresh()}>
            Refresh token
          </button>
          <button className="app-button" type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </section>
      <section className="card" aria-busy={settingsQuery.isLoading}>
        <h3>Baseline monitoring</h3>
        {settingsQuery.isLoading ? (
          <p>Loading settings…</p>
        ) : settingsQuery.isError ? (
          <p className="card__error">Unable to load settings.</p>
        ) : (
          <div style={{ display: 'grid', gap: 12, maxWidth: 360 }}>
            {BASELINE_FIELDS.map((field) => {
              const value = baselineValues[field.key] ?? '';
              const busy = savingKey === field.key && updateSetting.isPending;
              return (
                <label
                  key={field.key}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                  aria-busy={busy}
                >
                  <span>{field.label}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={value}
                    min={field.min ?? undefined}
                    max={field.max ?? undefined}
                    step={field.step}
                    onChange={(event) =>
                      setBaselineValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                    }
                    onBlur={() => handleSave(field.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                  <small className="muted">{field.help}</small>
                </label>
              );
            })}
          </div>
        )}
      </section>
      <section className="card">
        <h3>Route access matrix</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Route</th>
              {ROUTE_ROLES.overview.map((role) => (
                <th key={role}>{role}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(ROUTE_ROLES).map(([route, roles]) => {
              const allowed = new Set<Role>(roles as Role[]);
              return (
                <tr key={route}>
                  <td>{route}</td>
                  {ROUTE_ROLES.overview.map((role) => (
                    <td key={`${route}-${role}`}>{allowed.has(role) ? '✓' : '—'}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
