import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import { useAuthFetch } from '@hooks/useAuthFetch';
import type { Device } from '@api/types';
import { useAuth } from '@app/providers/AuthProvider';

const PAGE_SIZE = 100;
const SEARCH_THRESHOLD = 500;

interface DeviceSearchRow {
  device_id: string;
  site_id: string | null;
  firmware: string | null;
  model: string | null;
  online: boolean;
  last_seen_at: string | null;
  region: string | null;
  open_alerts: number;
  health: 'healthy' | 'unhealthy';
}

interface DeviceSearchResponse {
  results: DeviceSearchRow[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export function DevicesPage(): JSX.Element {
  const authFetch = useAuthFetch();
  const { hasRole } = useAuth();
  const canUseSearch = hasRole(['admin', 'ops']);
  const [params, setParams] = useSearchParams();
  const selectedSite = params.get('site') ?? '';
  const selectedRegion = params.get('region') ?? '';
  const selectedHealth = params.get('health') ?? '';
  const rawPage = Number(params.get('page') ?? '0');
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0;

  const [siteInput, setSiteInput] = useState(selectedSite);

  useEffect(() => {
    setSiteInput(selectedSite);
  }, [selectedSite]);

  const filterKey = useMemo(
    () => ({ site: selectedSite, region: selectedRegion, health: selectedHealth }),
    [selectedHealth, selectedRegion, selectedSite],
  );

  const buildSearchQuery = useCallback(
    (limit: number, offset: number) => {
      const search = new URLSearchParams();
      if (selectedSite) {
        search.set('site_id', selectedSite);
      }
      if (selectedRegion) {
        search.set('region', selectedRegion);
      }
      if (selectedHealth) {
        search.set('health', selectedHealth);
      }
      search.set('limit', String(limit));
      search.set('offset', String(offset));
      return `/api/devices/search?${search.toString()}`;
    },
    [selectedHealth, selectedRegion, selectedSite],
  );

  const searchProbe = useQuery({
    queryKey: ['devices', 'probe', filterKey],
    queryFn: () => apiFetch<DeviceSearchResponse>(buildSearchQuery(1, 0), undefined, authFetch),
    enabled: canUseSearch,
    refetchInterval: 20_000,
  });

  const probeTotal = searchProbe.data?.total;
  const probeError = searchProbe.isError;
  const shouldUseSearch = canUseSearch && !probeError && probeTotal !== undefined && probeTotal > SEARCH_THRESHOLD;
  const enableClientList =
    !canUseSearch || probeError || (probeTotal !== undefined && probeTotal <= SEARCH_THRESHOLD);
  const waitingForProbe = canUseSearch && !probeError && probeTotal === undefined;

  useEffect(() => {
    if (!shouldUseSearch && params.get('page')) {
      const next = new URLSearchParams(params);
      next.delete('page');
      setParams(next, { replace: true });
    }
  }, [params, setParams, shouldUseSearch]);

  const { data: clientData, isLoading: isClientLoading, isError: isClientError } = useQuery({
    queryKey: ['devices', 'list'],
    queryFn: () => apiFetch<Device[]>('/api/devices', undefined, authFetch),
    refetchInterval: 20_000,
    enabled: enableClientList,
  });

  const {
    data: searchData,
    isLoading: isSearchLoading,
    isError: isSearchError,
    isFetching: isSearchFetching,
  } = useQuery({
    queryKey: ['devices', 'search', filterKey, page],
    queryFn: () => apiFetch<DeviceSearchResponse>(buildSearchQuery(PAGE_SIZE, page * PAGE_SIZE), undefined, authFetch),
    refetchInterval: 20_000,
    enabled: shouldUseSearch,
  });

  const searchDevices = useMemo(
    () => (searchData?.results ?? []).map(mapSearchRow),
    [searchData],
  );

  const filteredDevices = useMemo(() => {
    if (shouldUseSearch) {
      return searchDevices;
    }
    if (!clientData) {
      return [];
    }
    return clientData.filter((device) => matchesFilters(device, selectedSite, selectedRegion, selectedHealth));
  }, [clientData, searchDevices, selectedHealth, selectedRegion, selectedSite, shouldUseSearch]);

  const totalDevices = shouldUseSearch
    ? searchData?.total ?? probeTotal ?? 0
    : filteredDevices.length;

  const isLoading = shouldUseSearch
    ? isSearchLoading
    : enableClientList
      ? isClientLoading
      : waitingForProbe;
  const isError = shouldUseSearch ? isSearchError : enableClientList ? isClientError : searchProbe.isError;

  const hasNextPage = shouldUseSearch ? searchData?.has_more ?? false : false;
  const hasPrevPage = shouldUseSearch ? page > 0 : false;

  const activeFilters = [
    selectedSite ? `Site ${selectedSite}` : null,
    selectedRegion ? `Region ${selectedRegion}` : null,
    selectedHealth ? `Health ${selectedHealth}` : null,
  ].filter(Boolean);

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (value && value.length) {
        next.set(key, value);
      } else {
        next.delete(key);
      }
      next.delete('page');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const clearFilters = () => {
    const next = new URLSearchParams(params);
    next.delete('site');
    next.delete('region');
    next.delete('health');
    next.delete('page');
    setParams(next, { replace: true });
    setSiteInput('');
  };

  const handleSiteSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    updateParam('site', siteInput.trim() ? siteInput.trim() : null);
  };

  const handleHealthChange = (value: string) => {
    updateParam('health', value || null);
  };

  const goToPage = (nextPage: number) => {
    const next = new URLSearchParams(params);
    if (nextPage <= 0) {
      next.delete('page');
    } else {
      next.set('page', String(nextPage));
    }
    setParams(next, { replace: true });
  };

  const renderPagination = shouldUseSearch && (searchDevices.length > 0 || totalDevices > 0);
  const rangeStart = shouldUseSearch ? (totalDevices === 0 ? 0 : page * PAGE_SIZE + 1) : 0;
  const rangeEnd = shouldUseSearch
    ? searchDevices.length > 0
      ? page * PAGE_SIZE + searchDevices.length
      : rangeStart
    : 0;

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Devices</h2>
          <p className="page__subtitle">Browse inventory and jump into live telemetry</p>
        </div>
      </header>
      <form
        className="card"
        onSubmit={handleSiteSubmit}
        style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
          <span className="data-table__muted">Site</span>
          <input
            type="text"
            value={siteInput}
            onChange={(event) => setSiteInput(event.target.value)}
            placeholder="SITE-1234"
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid #d1d5db',
              fontSize: 14,
            }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
          <span className="data-table__muted">Health</span>
          <select
            value={selectedHealth}
            onChange={(event) => handleHealthChange(event.target.value)}
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
            <option value="unhealthy">Unhealthy</option>
          </select>
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="app-button">
            Apply filters
          </button>
          <button
            type="button"
            className="app-button"
            onClick={clearFilters}
          >
            Reset
          </button>
        </div>
      </form>
      {activeFilters.length ? (
        <div className="card filter-banner">
          <span>Filters: {activeFilters.join(', ')}</span>
          <button type="button" className="app-button" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : null}
      {isLoading ? (
        <div className="card">Loading devices…</div>
      ) : isError ? (
        <div className="card card--error">Unable to load devices. Check your API connection.</div>
      ) : filteredDevices.length > 0 ? (
        <section className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <strong>Total devices: {totalDevices}</strong>
            {shouldUseSearch && searchData && (
              <span className="data-table__muted">
                Page {page + 1} • Showing {searchDevices.length} per page
                {isSearchFetching ? ' (updating…)' : ''}
              </span>
            )}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Status</th>
                <th>Site</th>
                <th>Region</th>
                <th>Last heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.map((device) => (
                <tr key={device.id}>
                  <td>
                    <Link to={`/devices/${device.id}`} className="inline-link">
                      {device.name}
                    </Link>
                    {device.serialNumber ? <div className="data-table__muted">SN {device.serialNumber}</div> : null}
                  </td>
                  <td>
                    <StatusPill status={device.status} />
                  </td>
                  <td>{device.site?.name ?? '—'}</td>
                  <td>{device.site?.region ?? device.region ?? '—'}</td>
                  <td>{device.lastHeartbeat ? new Date(device.lastHeartbeat).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {renderPagination ? (
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
                Showing {rangeStart}-{rangeEnd} of {totalDevices}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
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
      ) : (
        <div className="card">No devices match the current filters.</div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: Device['status'] }): JSX.Element {
  const tone = status === 'online' ? 'positive' : status === 'offline' ? 'negative' : 'neutral';
  return <span className={`status-pill status-pill--${tone}`}>{status}</span>;
}

function mapSearchRow(row: DeviceSearchRow): Device {
  const isOnline = row.online;
  const siteId = row.site_id ?? undefined;
  return {
    id: row.device_id,
    name: row.device_id,
    siteId,
    region: row.region ?? undefined,
    site: siteId
      ? {
          id: siteId,
          name: siteId,
          region: row.region ?? undefined,
        }
      : undefined,
    status: isOnline ? 'online' : 'offline',
    lastHeartbeat: row.last_seen_at ?? undefined,
  };
}

function matchesFilters(device: Device, site: string, region: string, health: string): boolean {
  const matchesSite = site ? device.siteId === site || device.site?.id === site : true;
  const matchesRegion = region
    ? device.region === region || device.site?.region === region
    : true;

  if (!health) {
    return matchesSite && matchesRegion;
  }

  const derivedOnline = resolveOnline(device);
  const openAlerts = Number((device as unknown as { open_alerts?: number; openAlerts?: number }).open_alerts ?? 0);
  const openAlertsAlt = Number((device as unknown as { open_alerts?: number; openAlerts?: number }).openAlerts ?? 0);
  const totalAlerts = Number.isFinite(openAlerts)
    ? openAlerts
    : Number.isFinite(openAlertsAlt)
      ? openAlertsAlt
      : 0;
  const healthFlag = (device as unknown as { health?: string }).health;

  let matchesHealth = true;
  if (health === 'online') {
    matchesHealth = derivedOnline === true;
  } else if (health === 'offline') {
    matchesHealth = derivedOnline === false;
  } else if (health === 'unhealthy') {
    matchesHealth = derivedOnline === false || totalAlerts > 0 || healthFlag === 'unhealthy';
  }

  return matchesSite && matchesRegion && matchesHealth;
}

function resolveOnline(device: Device): boolean | null {
  if (typeof (device as unknown as { online?: boolean }).online === 'boolean') {
    return (device as unknown as { online?: boolean }).online ?? null;
  }
  if (device.status === 'online') {
    return true;
  }
  if (device.status === 'offline') {
    return false;
  }
  return null;
}
