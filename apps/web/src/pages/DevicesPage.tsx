import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link, useSearchParams } from 'react-router-dom';

const THRESHOLD = 500; // switch to server pagination above this
const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;
const VIRTUALIZATION_THRESHOLD = 1000;

type RegionRow = {
  region: string;
  sites: number;
};

type DeviceSearchRow = {
  device_id: string;
  site_id: string | null;
  site_name?: string | null;
  region: string | null;
  firmware: string | null;
  model: string | null;
  online: number | boolean | null;
  last_seen_at: string | null;
  open_alerts: number | null;
  health?: 'healthy' | 'unhealthy' | 'empty';
};

type DeviceSearchResponse = {
  results: DeviceSearchRow[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
};

type DeviceListRow = {
  device_id: string;
  site_id: string | null;
  site_name?: string | null;
  region: string | null;
  online: number | null;
  last_seen_at: string | null;
  open_alerts?: number | null;
  openAlerts?: number | null;
};

type DeviceRow = {
  id: string;
  siteId?: string;
  siteName?: string;
  region?: string;
  lastSeen?: string | null;
  online?: boolean | null;
  openAlerts?: number;
  health?: 'healthy' | 'unhealthy';
};

type DeviceQueryResult = {
  results: DeviceRow[];
  total: number;
  hasMore: boolean;
};

type VirtualRow = {
  index: number;
  start: number;
  size: number;
};

function buildSearchURL(base: string, params: Record<string, string | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) {
      sp.set(k, v);
    }
  }
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapSearchRow(row: DeviceSearchRow): DeviceRow {
  const openAlerts = toNumber(row.open_alerts) ?? 0;
  const online =
    row.online === true || row.online === 1
      ? true
      : row.online === false || row.online === 0
        ? false
        : null;
  const derivedUnhealthy = row.health === 'unhealthy' || online === false || openAlerts > 0;
  return {
    id: row.device_id,
    siteId: row.site_id ?? undefined,
    siteName: row.site_name ?? row.site_id ?? undefined,
    region: row.region ?? undefined,
    lastSeen: row.last_seen_at ?? null,
    online,
    openAlerts,
    health: derivedUnhealthy ? 'unhealthy' : 'healthy',
  };
}

function mapClientRow(row: DeviceListRow): DeviceRow {
  const online = row.online === null || row.online === undefined ? null : row.online === 1;
  const openAlerts =
    toNumber((row as { open_alerts?: number | null }).open_alerts) ??
    toNumber((row as { openAlerts?: number | null }).openAlerts) ??
    0;
  const derivedUnhealthy = online === false || openAlerts > 0;
  return {
    id: row.device_id,
    siteId: row.site_id ?? undefined,
    siteName: row.site_name ?? row.site_id ?? undefined,
    region: row.region ?? undefined,
    lastSeen: row.last_seen_at ?? null,
    online,
    openAlerts,
    health: derivedUnhealthy ? 'unhealthy' : 'healthy',
  };
}

function isUnhealthy(row: DeviceRow): boolean {
  if (row.health === 'unhealthy') {
    return true;
  }
  if (row.online === false) {
    return true;
  }
  return (row.openAlerts ?? 0) > 0;
}

function matchesHealth(row: DeviceRow, health: string): boolean {
  if (!health) {
    return true;
  }
  if (health === 'online') {
    return row.online === true;
  }
  if (health === 'offline') {
    return row.online === false;
  }
  if (health === 'unhealthy') {
    return isUnhealthy(row);
  }
  return true;
}

function statusFor(row: DeviceRow): 'online' | 'offline' | 'unknown' {
  if (row.online === true) {
    return 'online';
  }
  if (row.online === false) {
    return 'offline';
  }
  return 'unknown';
}

export default function DevicesPage() {
  const [params, setParams] = useSearchParams();
  const site = params.get('site') ?? '';
  const region = params.get('region') ?? '';
  const health = params.get('health') ?? '';
  const pageParam = Number(params.get('page') ?? '0');
  const page = Number.isFinite(pageParam) && pageParam >= 0 ? pageParam : 0;
  const limitParam = Number(params.get('limit') ?? '');
  const pageSize = PAGE_SIZE_OPTIONS.includes(limitParam as (typeof PAGE_SIZE_OPTIONS)[number])
    ? (limitParam as (typeof PAGE_SIZE_OPTIONS)[number])
    : DEFAULT_PAGE_SIZE;
  const unhealthyOnly = health === 'unhealthy';
  const [siteFilter, setSiteFilter] = useState('');
  const siteFilterTrimmed = siteFilter.trim();
  const deferredSiteFilter = useDeferredValue(siteFilterTrimmed);

  const regions = useQuery({
    queryKey: ['regions'],
    queryFn: async () =>
      (await (await fetch('/api/regions')).json()) as { regions: RegionRow[] },
    staleTime: 5 * 60 * 1000,
  });
  const regionOpts = useMemo(
    () => (regions.data?.regions ?? []).map((r) => r.region).filter(Boolean),
    [regions.data?.regions],
  );

  const meta = useQuery({
    queryKey: ['devices-meta', { site, region, health }],
    queryFn: async () => {
      const url = buildSearchURL('/api/devices/search', {
        site_id: site || undefined,
        region: region || undefined,
        health: health || undefined,
        limit: '1',
        offset: '0',
      });
      const r = await fetch(url);
      const j = await r.json();
      const total =
        typeof j?.total === 'number'
          ? j.total
          : Array.isArray(j)
            ? j.length
            : typeof j?.results?.length === 'number'
              ? j.results.length
              : 0;
      return { total } as { total: number };
    },
    refetchInterval: 10_000,
  });

  const serverMode = meta.isSuccess ? (meta.data?.total ?? 0) > THRESHOLD : false;

  useEffect(() => {
    if (!serverMode && page !== 0 && !meta.isLoading) {
      const next = new URLSearchParams(params);
      next.delete('page');
      setParams(next, { replace: true });
    }
  }, [meta.isLoading, page, params, serverMode, setParams]);

  const devices = useQuery<DeviceQueryResult>({
    queryKey: ['devices', { serverMode, site, region, health, page, pageSize }],
    queryFn: async () => {
      if (serverMode) {
        const url = buildSearchURL('/api/devices/search', {
          site_id: site || undefined,
          region: region || undefined,
          health: health || undefined,
          limit: String(pageSize),
          offset: String(page * pageSize),
        });
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error('Failed to fetch devices');
        }
        const data = (await response.json()) as DeviceSearchResponse;
        const rows = (data.results ?? []).map(mapSearchRow);
        return {
          results: rows,
          total: typeof data.total === 'number' ? data.total : rows.length,
          hasMore: Boolean(data.has_more),
        };
      }

      const url = buildSearchURL('/api/devices', {
        site: site || undefined,
        region: region || undefined,
        online: health === 'online' ? '1' : health === 'offline' ? '0' : undefined,
      });
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to fetch devices');
      }
      const data = (await response.json()) as DeviceListRow[];
      const rows = data.map(mapClientRow);
      const filtered = rows.filter((row) => matchesHealth(row, health));
      return {
        results: filtered,
        total: filtered.length,
        hasMore: false,
      };
    },
    placeholderData: (previous) => previous ?? { results: [], total: 0, hasMore: false },
    refetchInterval: 10_000,
    enabled: !meta.isLoading,
  });

  const updateSearchParams = (mutator: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    mutator(next);
    next.delete('page');
    setParams(next, { replace: true });
  };

  const sites = useQuery({
    queryKey: ['site-list', { region, q: deferredSiteFilter }],
    queryFn: async () => {
      const url = buildSearchURL('/api/site-list', {
        region: region || undefined,
        limit: '2000',
        q: deferredSiteFilter || undefined,
      });
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to fetch sites');
      }
      const data = (await response.json()) as {
        sites?: Array<{ site_id: string; name?: string | null; region?: string | null }>;
      };
      return data.sites ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const siteOptions = useMemo(() => {
    const options = (sites.data ?? []).map((item) => ({
      value: item.site_id,
      label: item.name ? `${item.name} (${item.site_id})` : item.site_id,
    }));
    if (site && !options.some((option) => option.value === site)) {
      options.unshift({ value: site, label: site });
    }
    return options;
  }, [site, sites.data]);

  const handleSiteChange = (value: string) => {
    updateSearchParams((next) => {
      if (value) {
        next.set('site', value.trim());
      } else {
        next.delete('site');
      }
    });
  };

  const handleRegionChange = (value: string) => {
    updateSearchParams((next) => {
      if (value) {
        next.set('region', value);
      } else {
        next.delete('region');
      }
    });
  };

  const handleHealthChange = (value: string) => {
    updateSearchParams((next) => {
      if (value) {
        next.set('health', value);
      } else {
        next.delete('health');
      }
    });
  };

  const handleUnhealthyToggle = (checked: boolean) => {
    updateSearchParams((next) => {
      if (checked) {
        next.set('health', 'unhealthy');
      } else if (next.get('health') === 'unhealthy') {
        next.delete('health');
      }
    });
  };

  const clearFilters = () => {
    const next = new URLSearchParams(params);
    next.delete('site');
    next.delete('region');
    next.delete('health');
    next.delete('page');
    setParams(next, { replace: true });
    setSiteFilter('');
  };

  const handlePageSizeChange = (value: string) => {
    const parsed = Number(value);
    updateSearchParams((next) => {
      if (PAGE_SIZE_OPTIONS.includes(parsed as (typeof PAGE_SIZE_OPTIONS)[number])) {
        next.set('limit', String(parsed));
      } else {
        next.delete('limit');
      }
    });
  };

  const goToPage = (nextPage: number) => {
    const safe = Math.max(0, nextPage);
    const next = new URLSearchParams(params);
    if (safe === 0) {
      next.delete('page');
    } else {
      next.set('page', String(safe));
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (
      !site ||
      !sites.data ||
      sites.isLoading ||
      sites.isFetching ||
      sites.isError ||
      deferredSiteFilter
    ) {
      return;
    }
    const exists = sites.data.some((item) => item.site_id === site);
    if (!exists) {
      const next = new URLSearchParams(params);
      next.delete('site');
      setParams(next, { replace: true });
    }
  }, [
    deferredSiteFilter,
    params,
    setParams,
    site,
    sites.data,
    sites.isError,
    sites.isFetching,
    sites.isLoading,
  ]);

  const total = devices.data?.total ?? 0;
  const rows: DeviceRow[] = devices.data?.results ?? [];
  const hasNextPage =
    serverMode && (devices.data?.hasMore ?? (page + 1) * pageSize < total);
  const hasPrevPage = serverMode && page > 0;
  const rangeStart = serverMode ? (total === 0 ? 0 : page * pageSize + 1) : 0;
  const rangeEnd = serverMode ? Math.min(total, page * pageSize + rows.length) : 0;

  const activeFilters = useMemo(() => {
    const filters: Array<{ key: string; label: string }> = [];
    if (site) {
      filters.push({ key: 'site', label: `Site ${site}` });
    }
    if (region) {
      filters.push({ key: 'region', label: `Region ${region}` });
    }
    if (health) {
      if (health === 'unhealthy') {
        filters.push({ key: 'health', label: 'Unhealthy only' });
      } else {
        filters.push({ key: 'health', label: `Health ${health}` });
      }
    }
    return filters;
  }, [health, region, site]);

  const healthSelectValue = unhealthyOnly ? '' : health;
  const isLoading = meta.isLoading || devices.isLoading;
  const isError = meta.isError || devices.isError;
  const virtualizationEnabled = !serverMode && rows.length > VIRTUALIZATION_THRESHOLD;
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: virtualizationEnabled ? rows.length : 0,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => 36,
    overscan: 12,
    measureElement: (element?: Element | null) => element?.getBoundingClientRect().height ?? 0,
  });
  const virtualItems = rowVirtualizer.getVirtualItems() as VirtualRow[];
  const virtualRows: VirtualRow[] = virtualizationEnabled ? virtualItems : [];

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Devices</h2>
          <p className="page__subtitle">Browse inventory and jump into live telemetry</p>
        </div>
        {activeFilters.length ? (
          <div className="chip-group" aria-label="Active filters">
            {activeFilters.map((filter) => (
              <span key={filter.key} className="chip chip--active chip--readonly">
                {filter.label}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      <section
        className="card"
        style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 }}>
          <span className="data-table__muted">Site</span>
          <input
            type="text"
            value={siteFilter}
            onChange={(event) => setSiteFilter(event.target.value)}
            placeholder="Filter sites…"
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid #d1d5db',
              fontSize: 14,
            }}
          />
          <select
            value={site}
            onChange={(event) => handleSiteChange(event.target.value)}
            disabled={sites.isLoading}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid #d1d5db',
              fontSize: 14,
            }}
          >
            <option value="">Any</option>
            {siteOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
          <span className="data-table__muted">Region</span>
          <select
            value={region}
            onChange={(event) => handleRegionChange(event.target.value)}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid #d1d5db',
              fontSize: 14,
            }}
          >
            <option value="">Any</option>
            {regionOpts.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
          <span className="data-table__muted">Health</span>
          <select
            value={healthSelectValue}
            onChange={(event) => handleHealthChange(event.target.value)}
            disabled={unhealthyOnly}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid #d1d5db',
              fontSize: 14,
            }}
          >
            <option value="">Any</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 160 }}>
          <input
            type="checkbox"
            checked={unhealthyOnly}
            onChange={(event) => handleUnhealthyToggle(event.target.checked)}
          />
          <span className="data-table__muted">Unhealthy only</span>
        </label>
        <button type="button" className="app-button" onClick={clearFilters}>
          Clear filters
        </button>
      </section>

      {isLoading ? (
        <div className="card">Loading devices…</div>
      ) : isError ? (
        <div className="card card--error">Unable to load devices. Check your API connection.</div>
      ) : rows.length === 0 ? (
        <section
          className="card"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
            padding: 32,
            textAlign: 'center',
          }}
        >
          <div>
            <strong>No matches</strong>
            <p className="data-table__muted" style={{ marginTop: 4 }}>
              Adjust or clear your filters to see devices again.
            </p>
          </div>
          <button type="button" className="app-button" onClick={clearFilters}>
            Clear filters
          </button>
        </section>
      ) : (
        <section className="card">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <strong>Total devices: {total}</strong>
            {serverMode ? (
              <span className="data-table__muted">
                Page {page + 1} • {pageSize} per page
                {devices.isFetching ? ' (updating…)' : ''}
              </span>
            ) : null}
          </div>
          <div
            ref={tableScrollRef}
            style={
              virtualizationEnabled
                ? {
                    maxHeight: '70vh',
                    overflowY: 'auto',
                  }
                : undefined
            }
          >
            <table className="data-table" style={{ width: '100%', tableLayout: 'fixed' }}>
              <thead
                style={
                  virtualizationEnabled
                    ? { display: 'table', width: '100%', tableLayout: 'fixed' }
                    : undefined
                }
              >
                <tr>
                  <th>Device</th>
                  <th>Status</th>
                  <th>Site</th>
                  <th>Region</th>
                  <th>Last heartbeat</th>
                  <th>Open alerts</th>
                </tr>
              </thead>
              <tbody
                style={
                  virtualizationEnabled
                    ? {
                        position: 'relative',
                        display: 'block',
                        height: `${rowVirtualizer.getTotalSize()}px`,
                        width: '100%',
                      }
                    : undefined
                }
              >
                {virtualizationEnabled
                  ? virtualRows.map((virtualRow) => {
                      const device = rows[virtualRow.index];
                      return (
                        <tr
                          key={device.id}
                          data-index={virtualRow.index}
                          style={{
                            position: 'absolute',
                            top: 0,
                            transform: `translateY(${virtualRow.start}px)`,
                            display: 'table',
                            width: '100%',
                            tableLayout: 'fixed',
                            height: `${virtualRow.size}px`,
                          }}
                        >
                          <td>
                            <Link to={`/devices/${device.id}`} className="inline-link">
                              {device.id}
                            </Link>
                            {device.siteId ? (
                              <div className="data-table__muted">Site {device.siteId}</div>
                            ) : null}
                          </td>
                          <td>
                            <StatusPill status={statusFor(device)} />
                          </td>
                          <td>{device.siteName ?? '—'}</td>
                          <td>{device.region ?? '—'}</td>
                          <td>{device.lastSeen ? new Date(device.lastSeen).toLocaleString() : '—'}</td>
                          <td>{device.openAlerts ?? 0}</td>
                        </tr>
                      );
                    })
                  : rows.map((device) => (
                      <tr key={device.id}>
                        <td>
                          <Link to={`/devices/${device.id}`} className="inline-link">
                            {device.id}
                          </Link>
                          {device.siteId ? (
                            <div className="data-table__muted">Site {device.siteId}</div>
                          ) : null}
                        </td>
                        <td>
                          <StatusPill status={statusFor(device)} />
                        </td>
                        <td>{device.siteName ?? '—'}</td>
                        <td>{device.region ?? '—'}</td>
                        <td>{device.lastSeen ? new Date(device.lastSeen).toLocaleString() : '—'}</td>
                        <td>{device.openAlerts ?? 0}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          {serverMode ? (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 16,
                gap: 12,
              }}
            >
              <span className="data-table__muted">
                Showing {rangeStart}-{rangeEnd} of {total}
                {devices.isFetching ? ' (updating…)' : ''}
              </span>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <label className="data-table__muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  Per page
                  <select
                    value={String(pageSize)}
                    onChange={(event) => handlePageSizeChange(event.target.value)}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: '1px solid #d1d5db',
                      fontSize: 14,
                    }}
                  >
                    {PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="app-button"
                  onClick={() => goToPage(page - 1)}
                  disabled={!hasPrevPage}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="app-button"
                  onClick={() => goToPage(page + 1)}
                  disabled={!hasNextPage}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: 'online' | 'offline' | 'unknown' }) {
  const tone = status === 'online' ? 'positive' : status === 'offline' ? 'negative' : 'neutral';
  return <span className={`status-pill status-pill--${tone}`}>{status}</span>;
}

export { DevicesPage };
