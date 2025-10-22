import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getOpsSnapshot } from '@api/ops';
import { useAuthFetch } from '@hooks/useAuthFetch';

interface GaugeConfig {
  label: string;
  value: number;
  suffix?: string;
  target: number;
  invert?: boolean;
}

export function OpsPage(): JSX.Element {
  const authFetch = useAuthFetch();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['ops', 'slo'],
    queryFn: () => getOpsSnapshot(authFetch),
    refetchInterval: 10_000,
  });

  const gauges = useMemo<GaugeConfig[]>(() => {
    if (!data) {
      return [];
    }
    return [
      { label: 'Ingest success', value: data.ingest_success_pct, suffix: '%', target: 99 },
      { label: 'Heartbeat freshness', value: data.heartbeat_freshness_pct, suffix: '%', target: 97 },
      { label: 'p95 ingest→cache', value: data.p95_ingest_latency_ms, suffix: 'ms', target: 800, invert: true },
      { label: 'Burn rate (10m)', value: data.burn, target: 1.0, invert: true },
    ];
  }, [data]);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Operations</h2>
          <p className="page__subtitle">Live burn rates and SLOs from your Worker</p>
        </div>
      </header>
      {isLoading ? (
        <div className="card">Loading SLO snapshot…</div>
      ) : isError ? (
        <div className="card card--error">Failed to load SLO feed. Check the Worker endpoint.</div>
      ) : data ? (
        <>
          <section className="card">
            <div className="gauge-grid">
              {gauges.map((gauge) => (
                <Gauge key={gauge.label} {...gauge} />
              ))}
            </div>
          </section>
          <section className="card">
            <h3>Raw payload</h3>
            <pre className="json-block">{JSON.stringify(data, null, 2)}</pre>
          </section>
        </>
      ) : (
        <div className="card">No SLO snapshot available.</div>
      )}
    </div>
  );
}

function Gauge({ label, value, suffix, target, invert }: GaugeConfig): JSX.Element {
  const percentage = computePercentage(value, target, invert);
  const tone = percentage >= 0.95 ? 'positive' : percentage >= 0.75 ? 'warning' : 'negative';
  const formatted = suffix ? `${value.toFixed(suffix === 'ms' ? 0 : 1)}${suffix}` : value.toFixed(2);

  return (
    <div className={`gauge gauge--${tone}`}>
      <div className="gauge__header">
        <span className="gauge__label">{label}</span>
        <span className="gauge__target">Target {target}{suffix ?? ''}</span>
      </div>
      <div className="gauge__bar">
        <div className="gauge__fill" style={{ width: `${Math.max(Math.min(percentage * 100, 100), 0)}%` }} />
      </div>
      <div className="gauge__value">{formatted}</div>
    </div>
  );
}

function computePercentage(value: number, target: number, invert = false): number {
  if (invert) {
    if (value <= target) return 1;
    if (value >= target * 2) return 0;
    return 1 - (value - target) / target;
  }
  if (value >= target) return 1;
  if (target === 0) return 0;
  return value / target;
}
