import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sparkline } from '@components/charts/Sparkline';
import { SADevicesMap } from '@components/map/SADevicesMap';
import type { OverviewKpis, OverviewSparklineResponse } from '@api/types';
import { bandHigh, bandLow, type Band } from '@utils/bands';

type SiteSearchResult = {
  site_id?: string | null;
  siteId?: string | null;
  name?: string | null;
  region?: string | null;
  lat?: number | null;
  lon?: number | null;
  total_devices?: number | null;
  online_devices?: number | null;
  offline_devices?: number | null;
  open_alerts?: number | null;
  freshness_min?: number | null;
  health?: 'healthy' | 'unhealthy' | 'empty';
};

type OverviewKpisExtended = OverviewKpis & {
  heartbeat_fresh_min?: number;
  heartbeat_freshness_min?: number;
  low_delta_count?: number;
};

function KPI({ label, value, band, children }:{
  label: string;
  value: string;
  band: Band;
  children?: ReactNode;
}) {
  return (
    <div className={`kpi ${band}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {children}
    </div>
  );
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const [onlyBad, setOnlyBad] = useState(false);

  const kpiQuery = useQuery({
    queryKey: ['overview-kpis'],
    queryFn: async (): Promise<OverviewKpisExtended> => {
      const res = await fetch('/api/overview/kpis');
      if (!res.ok) {
        throw new Error('Failed to load KPIs');
      }
      return res.json();
    },
    refetchInterval: 10000,
  });

  const burnQuery = useQuery({
    queryKey: ['ops-burn'],
    queryFn: async (): Promise<number[]> => {
      const res = await fetch('/api/ops/burn-series?window=10m&step=1m');
      if (!res.ok) {
        return [];
      }
      const json = await res.json();
      const series = Array.isArray(json?.series) ? json.series : [];
      return series.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    },
    refetchInterval: 10000,
  });

  const sparkQuery = useQuery({
    queryKey: ['overview-sparklines'],
    queryFn: async (): Promise<OverviewSparklineResponse> => {
      const res = await fetch('/api/overview/sparklines');
      if (!res.ok) {
        return { cop: [], delta_t: [] };
      }
      return res.json();
    },
    refetchInterval: 10000,
  });

  const sitesQuery = useQuery({
    queryKey: ['sites', { onlyBad }],
    queryFn: async (): Promise<SiteSearchResult[]> => {
      const params = new URLSearchParams({ limit: '500', offset: '0' });
      if (onlyBad) {
        params.set('only_unhealthy', '1');
      }
      const res = await fetch(`/api/sites/search?${params.toString()}`);
      if (!res.ok) {
        throw new Error('Failed to load sites');
      }
      const json = await res.json();
      if (Array.isArray(json?.results)) {
        return json.results as SiteSearchResult[];
      }
      if (Array.isArray(json)) {
        return json as SiteSearchResult[];
      }
      return [];
    },
    refetchInterval: 10000,
  });

  const sites = sitesQuery.data ?? [];
  const sitesForMap = useMemo(
    () =>
      sites.map((site) => ({
        ...site,
        site_id: site.site_id ?? site.siteId ?? undefined,
        name: site.name ?? site.site_id ?? undefined,
        online: site.online_devices != null ? site.online_devices > 0 : undefined,
      })),
    [sites],
  );

  const kpis = kpiQuery.data;
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

  const burnSeries = burnQuery.data ?? [];
  const burnLatest = burnSeries.at(-1) ?? 0;
  const burnKind: Band = burnLatest > 2 ? 'crit' : burnLatest > 1 ? 'warn' : 'ok';

  const sparkData = sparkQuery.data ?? { cop: [], delta_t: [] };

  const alertSites = useMemo(() => {
    return sites
      .filter((site) => Number(site.open_alerts) > 0)
      .sort((a, b) => Number(b.open_alerts ?? 0) - Number(a.open_alerts ?? 0))
      .slice(0, 10);
  }, [sites]);

  const totalAlerts = alertSites.reduce((sum, site) => sum + Number(site.open_alerts ?? 0), 0);

  function onMarkerClick(siteId: string) {
    navigate(`/devices?site=${encodeURIComponent(siteId)}`);
  }

  return (
    <div className="dashboard">
      <div className="area-kpi-1">
        <KPI label="Online devices" value={`${onlinePct.toFixed(0)}%`} band={onlineBand} />
      </div>
      <div className="area-kpi-2">
        <KPI label="Average COP" value={avgCop.toFixed(2)} band={copBand} />
      </div>
      <div className="area-kpi-3">
        <KPI label="Low-ΔT" value={`${lowDeltaCount}`} band={lowDeltaBand} />
      </div>
      <div className="area-kpi-4">
        <KPI label="Last heartbeat freshness" value={`${hbFreshMin.toFixed(0)} min`} band={hbBand}>
          <div style={{ marginTop: 8 }}>
            <Sparkline
              data={burnSeries}
              width={200}
              height={44}
              kind={burnKind}
              showArea
              ariaLabel="Recent burn rate"
            />
          </div>
        </KPI>
      </div>

      <section className="card area-activity" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <header style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Devices overview</h3>
            <p className="muted" style={{ margin: 0 }}>Geo distribution and live health.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={onlyBad} onChange={(event) => setOnlyBad(event.target.checked)} />
              show only unhealthy
            </label>
            <RegionChips
              sites={sites}
              onClickRegion={(region) => navigate(`/devices?region=${encodeURIComponent(region)}`)}
            />
          </div>
        </header>

        <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid var(--gb-border)' }}>
          <SADevicesMap sites={sitesForMap} width={820} height={420} onClickMarker={onMarkerClick} />
        </div>

        <div
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          }}
        >
          <SparkTile title="ΔT trend" ariaLabel="Devices delta T trend" kind="warn" data={sparkData.delta_t} />
          <SparkTile title="COP trend" ariaLabel="Devices COP trend" kind="ok" data={sparkData.cop} />
        </div>
      </section>

      <aside className="card area-alerts" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <header>
          <h3 style={{ marginTop: 0, marginBottom: 4 }}>Alerts focus</h3>
          <p className="muted" style={{ margin: 0 }}>
            {totalAlerts > 0 ? `${totalAlerts} open alerts across highlighted sites` : 'No open alerts right now.'}
          </p>
        </header>
        {alertSites.length === 0 ? (
          <div className="muted">All tracked devices are stable.</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {alertSites.map((site) => {
              const siteId = site.site_id ?? site.siteId ?? '';
              const name = site.name ?? siteId;
              const alerts = Number(site.open_alerts ?? 0);
              const freshness = Number.isFinite(site.freshness_min) ? `${site.freshness_min} min` : '—';
              return (
                <li
                  key={siteId || name}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 12,
                    border: '1px solid var(--gb-border)',
                    borderRadius: 12,
                    padding: '10px 12px',
                    background: '#0f1622',
                  }}
                >
                  <div>
                    <Link to={`/devices?site=${encodeURIComponent(siteId)}`} style={{ color: 'inherit', fontWeight: 600 }}>
                      {name}
                    </Link>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {site.region ?? '—'} • last heartbeat {freshness}
                    </div>
                  </div>
                  <span className={`chip ${alerts > 3 ? 'crit' : alerts > 1 ? 'warn' : 'ok'}`}>
                    {alerts} alert{alerts === 1 ? '' : 's'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </div>
  );
}

function RegionChips({ sites, onClickRegion }:{ sites: SiteSearchResult[]; onClickRegion: (region: string) => void }) {
  const counts = useMemo(() => {
    const next = new Map<string, { total: number; unhealthy: number }>();
    for (const site of sites) {
      const region = site.region ?? '—';
      const bucket = next.get(region) ?? { total: 0, unhealthy: 0 };
      bucket.total += 1;
      if (site.health === 'unhealthy' || Number(site.open_alerts ?? 0) > 0 || Number(site.offline_devices ?? 0) > 0) {
        bucket.unhealthy += 1;
      }
      next.set(region, bucket);
    }
    return Array.from(next.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [sites]);

  if (!counts.length) {
    return null;
  }

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {counts.map(([region, bucket]) => (
        <button
          key={region}
          type="button"
          onClick={() => onClickRegion(region)}
          className="pill"
          style={{ borderColor: bucket.unhealthy > 0 ? 'var(--gb-chart-warn)' : undefined }}
        >
          {region}: {bucket.total}
          {bucket.unhealthy > 0 ? ` • ${bucket.unhealthy} ⚠︎` : ''}
        </button>
      ))}
    </div>
  );
}

function SparkTile({ title, data, kind, ariaLabel }:{
  title: string;
  data: number[];
  kind: 'ok' | 'warn' | 'crit';
  ariaLabel: string;
}) {
  return (
    <div
      style={{
        background: '#0f1622',
        border: '1px solid var(--gb-border)',
        borderRadius: 12,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600 }}>{title}</div>
      <Sparkline data={data ?? []} width={240} height={60} kind={kind} showArea ariaLabel={ariaLabel} />
    </div>
  );
}
