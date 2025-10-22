import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getOverviewKpis, getOverviewSparklines } from '@api/overview';
import { getSites } from '@api/sites';
import { useAuthFetch } from '@hooks/useAuthFetch';
import { SAFleetMap } from '@components/map/SAFleetMap';
import { Sparkline } from '@components/charts/Sparkline';

interface RegionSummary {
  region: string;
  total: number;
  online: number;
}

export function OverviewPage(): JSX.Element {
  const authFetch = useAuthFetch();
  const navigate = useNavigate();

  const kpiQuery = useQuery({
    queryKey: ['overview', 'kpis'],
    queryFn: () => getOverviewKpis(authFetch),
    refetchInterval: 30_000,
  });

  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: () => getSites(authFetch),
    refetchInterval: 45_000,
  });

  const sparklinesQuery = useQuery({
    queryKey: ['overview', 'sparklines'],
    queryFn: () => getOverviewSparklines(authFetch),
    refetchInterval: 90_000,
  });

  const regionSummaries = useMemo<RegionSummary[]>(() => {
    if (!sitesQuery.data) {
      return [];
    }
    const map = new Map<string, RegionSummary>();
    for (const site of sitesQuery.data) {
      const entry = map.get(site.region) ?? { region: site.region, total: 0, online: 0 };
      entry.total += 1;
      if (site.online) {
        entry.online += 1;
      }
      map.set(site.region, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.region.localeCompare(b.region));
  }, [sitesQuery.data]);

  const handleSelectSite = (siteId: string) => {
    navigate(`/devices?site=${encodeURIComponent(siteId)}`);
  };

  const handleSelectRegion = (region: string) => {
    navigate(`/devices?region=${encodeURIComponent(region)}`);
  };

  const isLoading = kpiQuery.isLoading && !kpiQuery.data;
  const hasError = Boolean(kpiQuery.error || sitesQuery.error || sparklinesQuery.error);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Fleet overview</h2>
          <p className="page__subtitle">Live fleet posture, regions and comfort trends</p>
        </div>
        <span className="page__updated">
          Updated{' '}
          {kpiQuery.data?.updated_at ? new Date(kpiQuery.data.updated_at).toLocaleTimeString() : '—'}
        </span>
      </header>
      {isLoading ? (
        <div className="card">Loading overview…</div>
      ) : hasError ? (
        <div className="card card--error">Failed to load overview. Check your API connection.</div>
      ) : kpiQuery.data ? (
        <>
          <section className="metric-grid">
            <MetricCard
              label="Fleet online"
              value={`${kpiQuery.data.online_pct.toFixed(1)}%`}
              tone={kpiQuery.data.online_pct >= 95 ? 'positive' : kpiQuery.data.online_pct >= 85 ? 'warning' : 'negative'}
            />
            <MetricCard
              label="Open alerts"
              value={kpiQuery.data.open_alerts}
              tone={kpiQuery.data.open_alerts > 0 ? 'warning' : 'neutral'}
            />
            <MetricCard
              label="Average COP"
              value={kpiQuery.data.avg_cop.toFixed(2)}
              tone={kpiQuery.data.avg_cop >= 3.0 ? 'positive' : 'neutral'}
            />
            <MetricCard
              label="Low ΔT devices"
              value={kpiQuery.data.low_dt}
              tone={kpiQuery.data.low_dt > 0 ? 'warning' : 'neutral'}
            />
          </section>

          <section className="grid grid--two">
            <div className="card">
              <header className="section-header">
                <div>
                  <h3>Fleet map</h3>
                  <p className="section-subtitle">Tap a site to jump into the Devices view</p>
                </div>
              </header>
              <div className="chip-group" aria-label="Filter devices by region">
                {regionSummaries.map((region) => (
                  <button
                    key={region.region}
                    className="chip"
                    type="button"
                    onClick={() => handleSelectRegion(region.region)}
                  >
                    {region.region} · {region.online}/{region.total}
                  </button>
                ))}
              </div>
              <SAFleetMap sites={sitesQuery.data ?? []} onSelectSite={handleSelectSite} />
            </div>
            <div className="card">
              <header className="section-header">
                <div>
                  <h3>Performance trends</h3>
                  <p className="section-subtitle">Latest rolling signals</p>
                </div>
              </header>
              <div className="sparkline-stack">
                <Sparkline
                  label="Fleet COP"
                  values={sparklinesQuery.data?.cop ?? []}
                  formatValue={(value) => value.toFixed(2)}
                  color="#0ea5e9"
                />
                <Sparkline
                  label="ΔT"
                  values={sparklinesQuery.data?.delta_t ?? []}
                  formatValue={(value) => `${value.toFixed(1)}°C`}
                  color="#22c55e"
                />
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

interface MetricCardProps {
  label: string;
  value: number | string;
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
