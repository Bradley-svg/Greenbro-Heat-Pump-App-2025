import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { brand } from '../../brand';
import { Sparkline } from '@components/charts/Sparkline';
import { bandHigh, bandLow, type Band } from '@utils/bands';
import { useOverviewData } from './useOverviewData';

function CompactStat({
  label,
  value,
  band,
  helper,
}:{
  label: string;
  value: string;
  band: Band;
  helper?: string;
}) {
  return (
    <div className={`compact-dashboard__stat compact-dashboard__stat--${band}`}>
      <span className="compact-dashboard__stat-label">{label}</span>
      <span
        className="compact-dashboard__stat-value"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={`${label}: ${value}`}
      >
        {value}
      </span>
      {helper ? <span className="compact-dashboard__stat-helper">{helper}</span> : null}
    </div>
  );
}

export default function CompactDashboard(): JSX.Element {
  const { kpiQuery, burnQuery, sparkQuery, sitesQuery } = useOverviewData();

  const kpis = kpiQuery.data;
  const burnSeries = burnQuery.data ?? [];
  const sparkData = sparkQuery.data ?? { cop: [], delta_t: [] };
  const sites = sitesQuery.data ?? [];

  const rawOnline = Number(kpis?.online_pct ?? 0);
  const onlinePct = Number.isFinite(rawOnline)
    ? rawOnline > 1
      ? rawOnline
      : rawOnline * 100
    : 0;
  const avgCop = Number.isFinite(kpis?.avg_cop) ? Number(kpis?.avg_cop) : 0;
  const lowDeltaCount = Number.isFinite(kpis?.low_delta_count)
    ? Number(kpis?.low_delta_count)
    : Number.isFinite(kpis?.low_dt)
    ? Number(kpis?.low_dt)
    : 0;

  const heartbeatFromKpi = Number.isFinite(kpis?.heartbeat_fresh_min)
    ? Number(kpis?.heartbeat_fresh_min)
    : Number.isFinite(kpis?.heartbeat_freshness_min)
    ? Number(kpis?.heartbeat_freshness_min)
    : null;
  const heartbeatFromSites = sites.reduce((max, site) => {
    const value = Number(site.freshness_min);
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  const hbFreshMin = heartbeatFromKpi ?? heartbeatFromSites;

  const onlineBand = bandHigh(onlinePct, 98, 95);
  const copBand = bandHigh(avgCop, 3.0, 2.5);
  const lowDeltaBand = bandLow(lowDeltaCount, 10, 25);
  const hbBand = bandLow(hbFreshMin, 5, 15);

  const burnLatest = burnSeries.at(-1) ?? 0;
  const burnKind: Band = burnLatest > 2 ? 'crit' : burnLatest > 1 ? 'warn' : 'ok';

  const alertSites = useMemo(() => {
    return sites
      .filter((site) => Number(site.open_alerts) > 0)
      .sort((a, b) => Number(b.open_alerts ?? 0) - Number(a.open_alerts ?? 0))
      .slice(0, 5);
  }, [sites]);

  const totalAlerts = alertSites.reduce((sum, site) => sum + Number(site.open_alerts ?? 0), 0);

  return (
    <div className="compact-dashboard">
      <header className="compact-dashboard__header">
        <div>
          <p className="compact-dashboard__eyebrow">{brand.product}</p>
          <h1 className="compact-dashboard__title">Mobile overview</h1>
        </div>
        <Link to="/overview" className="pill">
          Full dashboard
        </Link>
      </header>

      <section className="compact-dashboard__stats" aria-label="Key performance indicators">
        <CompactStat label="Online devices" value={`${onlinePct.toFixed(0)}%`} band={onlineBand} />
        <CompactStat label="Average COP" value={avgCop.toFixed(2)} band={copBand} />
        <CompactStat label="Low-ΔT" value={`${lowDeltaCount}`} band={lowDeltaBand} />
        <CompactStat label="Last heartbeat" value={`${hbFreshMin.toFixed(0)} min`} band={hbBand} />
      </section>

      <section className="compact-dashboard__card" aria-label="Burn rate">
        <header className="compact-dashboard__card-header">
          <h2>Burn rate</h2>
          <span className={`compact-dashboard__chip compact-dashboard__chip--${burnKind}`}>
            {burnKind === 'crit' ? 'Escalate now' : burnKind === 'warn' ? 'Watch closely' : 'Stable'}
          </span>
        </header>
        {burnSeries.length === 0 ? (
          <p className="compact-dashboard__empty">No burn data available</p>
        ) : (
          <Sparkline data={burnSeries} width={340} height={64} kind={burnKind} showArea ariaLabel="Recent burn rate" />
        )}
      </section>

      <section className="compact-dashboard__card" aria-label="Performance trends">
        <header className="compact-dashboard__card-header">
          <h2>Performance trends</h2>
        </header>
        <div className="compact-dashboard__trend-grid">
          <div>
            <h3 className="compact-dashboard__trend-title">Coefficient of performance</h3>
            {sparkData.cop.length === 0 ? (
              <p className="compact-dashboard__empty">No COP data</p>
            ) : (
              <Sparkline data={sparkData.cop} width={320} height={60} kind="ok" showArea ariaLabel="COP trend" />
            )}
          </div>
          <div>
            <h3 className="compact-dashboard__trend-title">ΔT trend</h3>
            {sparkData.delta_t.length === 0 ? (
              <p className="compact-dashboard__empty">No ΔT data</p>
            ) : (
              <Sparkline data={sparkData.delta_t} width={320} height={60} kind="warn" showArea ariaLabel="Delta T trend" />
            )}
          </div>
        </div>
      </section>

      <section className="compact-dashboard__card" aria-label="Active incidents">
        <header className="compact-dashboard__card-header">
          <h2>Active incidents</h2>
          <span className="compact-dashboard__subtitle">{totalAlerts} device alerts</span>
        </header>
        {alertSites.length === 0 ? (
          <p className="compact-dashboard__empty">All clear – no active incidents</p>
        ) : (
          <ul className="compact-dashboard__list">
            {alertSites.map((site) => {
              const name = site.name ?? site.site_id ?? 'Unknown site';
              const alerts = Number(site.open_alerts ?? 0);
              const freshness = Number.isFinite(site.freshness_min)
                ? `${Number(site.freshness_min).toFixed(0)} min since last heartbeat`
                : 'Heartbeat unknown';
              return (
                <li key={`${site.site_id ?? site.siteId ?? name}`} className="compact-dashboard__list-item">
                  <div>
                    <p className="compact-dashboard__list-title">{name}</p>
                    <p className="compact-dashboard__list-meta">{freshness}</p>
                  </div>
                  <span className="compact-dashboard__badge">{alerts}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
