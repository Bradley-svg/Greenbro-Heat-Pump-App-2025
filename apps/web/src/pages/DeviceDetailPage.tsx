import React, { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import { useAuthFetch } from '@hooks/useAuthFetch';
import { useBaselineCompare } from '@hooks/useBaselineCompare';
import type { DeviceLatestState, TelemetryPoint } from '@api/types';
import { Legend } from '@components/charts/Legend';
import {
  SeriesChart,
  type AlertWindow,
  type BandOverlay,
  type BandOverlayBuilder,
  type SeriesChartHandle,
  type SeriesPoint,
  type TimeWindow,
} from '@components/charts/SeriesChart';
import { rollingStats, type RollingPoint } from '@utils/rolling';
import { toast } from '@app/providers/toast';

const TELEMETRY_RANGES: Array<'24h' | '7d'> = ['24h', '7d'];

interface CommissioningWindowSummary {
  session_id: string;
  step_id: string;
  updated_at: string;
  pass: boolean;
  start: number | null;
  end: number | null;
  thresholds: Record<string, unknown> | null;
  sample: {
    delta_t_med: number | null;
    p25: number | null;
    p75: number | null;
  } | null;
}

interface DeviceBaselineSummary {
  baseline_id: string;
  created_at: string;
  label: string | null;
  is_golden: boolean;
  expires_at: string | null;
  sample: {
    median: number | null;
    p25: number | null;
    p75: number | null;
    window_s?: number | null;
    captured_at?: string | null;
  };
  thresholds: Record<string, unknown> | null;
  source_session_id: string | null;
  step_id: string | null;
}

type BaselineCompareResult = ReturnType<typeof useBaselineCompare>;

type BaselineSuggestionKind = 'delta_t' | 'cop' | 'current';

interface BaselineSuggestResponse {
  hasBaseline: boolean;
  kind?: BaselineSuggestionKind;
  sampleN?: number;
  units?: string;
  suggestions?: {
    drift_warn: number;
    drift_crit: number;
    note?: string;
  };
  recent?: {
    coverage?: number;
    baseline?: { p25: number; p75: number; median: number };
  };
}

const SUGGESTION_CONFIG = [
  { kind: 'delta_t', label: 'ΔT', warnKey: 'baseline_drift_warn', critKey: 'baseline_drift_crit' },
  { kind: 'cop', label: 'COP', warnKey: 'baseline_drift_warn_cop', critKey: 'baseline_drift_crit_cop' },
  {
    kind: 'current',
    label: 'Current',
    warnKey: 'baseline_drift_warn_current',
    critKey: 'baseline_drift_crit_current',
  },
] as const satisfies ReadonlyArray<{
  kind: BaselineSuggestionKind;
  label: string;
  warnKey: string;
  critKey: string;
}>;

export function DeviceDetailPage(): JSX.Element {
  const { deviceId } = useParams<{ deviceId: string }>();
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const [searchParams, setSearchParams] = useSearchParams();
  const authFetch = useAuthFetch();
  const queryClient = useQueryClient();
  const [baselineSaving, setBaselineSaving] = useState(false);
  const [baselineMutating, setBaselineMutating] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<'checks' | 'baselines'>('checks');
  const [baselineSuggestion, setBaselineSuggestion] = useState<BaselineSuggestResponse | null>(null);
  const [xDomain, setXDomain] = useState<[number, number] | null>(null);
  const focusAppliedRef = useRef(false);
  const deltaChartRef = useRef<SeriesChartHandle>(null);
  const copChartRef = useRef<SeriesChartHandle>(null);
  const currentChartRef = useRef<SeriesChartHandle>(null);

  const applySetting = useCallback(
    async (key: string, value: string) => {
      await apiFetch(
        '/api/admin/settings',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, value }),
        },
        authFetch,
      );
    },
    [authFetch],
  );

  const fetchSuggest = useCallback(
    async (kind: BaselineSuggestionKind) => {
      if (!deviceId) {
        return;
      }
      try {
        const params = new URLSearchParams({ kind, period: '7 days' });
        const response = await authFetch(
          `/api/devices/${deviceId}/baseline-suggest?${params.toString()}`,
          {},
        );
        if (!response.ok) {
          throw new Error(`Failed with status ${response.status}`);
        }
        const json = (await response.json()) as BaselineSuggestResponse;
        const payload: BaselineSuggestResponse = { ...json, kind: json.kind ?? kind };
        setBaselineSuggestion(payload);
        if (payload.hasBaseline && payload.suggestions) {
          const label = kind === 'delta_t' ? 'ΔT' : kind === 'cop' ? 'COP' : 'Current';
          const units = payload.units ?? '';
          toast.info(
            `Suggested ${label} drift: warn ${payload.suggestions.drift_warn}${units} / crit ${payload.suggestions.drift_crit}${units}`,
          );
        } else if (!payload.hasBaseline) {
          toast.warning('No baseline found for suggestions');
        } else {
          toast.warning('No recent telemetry for suggestions');
        }
      } catch (error) {
        console.error('Failed to fetch baseline suggestions', error);
        toast.error('Failed to load suggestions');
      }
    },
    [authFetch, deviceId],
  );

  const handleApplySuggestion = useCallback(
    async (config: (typeof SUGGESTION_CONFIG)[number], warn: number, crit: number) => {
      try {
        await Promise.all([
          applySetting(config.warnKey, String(warn)),
          applySetting(config.critKey, String(crit)),
        ]);
        toast.success(`Applied ${config.label} drift thresholds`);
      } catch (error) {
        console.error('Failed to apply drift thresholds', error);
        toast.error('Failed to apply thresholds');
      }
    },
    [applySetting],
  );

  const baselineDrawerState = useMemo(() => {
    const suggestion = baselineSuggestion;
    let summary: string | null = null;
    if (suggestion?.hasBaseline && suggestion.suggestions) {
      const label = suggestion.kind === 'delta_t' ? 'ΔT' : suggestion.kind === 'cop' ? 'COP' : 'Current';
      const units = suggestion.units ?? '';
      summary = `Last suggestion: ${label} warn ${suggestion.suggestions.drift_warn}${units} / crit ${suggestion.suggestions.drift_crit}${units}`;
    }
    return {
      busyId: baselineMutating,
      suggestion,
      onSuggest: fetchSuggest,
      onApply: handleApplySuggestion,
      summary,
    };
  }, [baselineMutating, baselineSuggestion, fetchSuggest, handleApplySuggestion]);

  if (!deviceId) {
    return <Navigate to="/devices" replace />;
  }

  useEffect(() => {
    focusAppliedRef.current = false;
  }, [deviceId]);

  const latestQuery = useQuery({
    queryKey: ['device', deviceId, 'latest'],
    queryFn: () => apiFetch<DeviceLatestState>(`/api/devices/${deviceId}/latest`, undefined, authFetch),
    refetchInterval: 10_000,
  });

  const telemetryQuery = useQuery({
    queryKey: ['device', deviceId, 'telemetry', range],
    queryFn: () => apiFetch<TelemetryPoint[]>(`/api/devices/${deviceId}/series?range=${range}`, undefined, authFetch),
    enabled: !!deviceId,
    refetchInterval: range === '24h' ? 20_000 : 60_000,
  });

  const alertWindowsQuery = useQuery({
    queryKey: ['device', deviceId, 'alert-windows', range],
    queryFn: () => apiFetch(`/api/alerts?device_id=${deviceId}&range=${range}`, undefined, authFetch),
    enabled: !!deviceId,
    refetchInterval: range === '24h' ? 10_000 : 30_000,
  });

  const windowsQuery = useQuery({
    queryKey: ['dev:win', deviceId],
    queryFn: () =>
      apiFetch<CommissioningWindowSummary[]>(
        `/api/devices/${deviceId}/commissioning/windows`,
        undefined,
        authFetch,
      ),
    enabled: !!deviceId,
    staleTime: 30_000,
  });

  const baselinesQuery = useQuery({
    queryKey: ['dev:baselines', deviceId],
    queryFn: () =>
      apiFetch<DeviceBaselineSummary[]>(
        `/api/devices/${deviceId}/baselines?kind=delta_t`,
        undefined,
        authFetch,
      ),
    enabled: !!deviceId,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (focusAppliedRef.current) {
      return;
    }
    focusAppliedRef.current = true;
    const fs = searchParams.get('focus_start');
    const fe = searchParams.get('focus_end');
    if (!fs || !fe) {
      return;
    }
    const start = Number(fs);
    const end = Number(fe);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return;
    }
    const span = Math.max(1, end - start);
    const pad = Math.max(span * 0.15, 1_000);
    const domain: [number, number] = [start - pad, end + pad];
    deltaChartRef.current?.setXDomain(domain);
    copChartRef.current?.setXDomain(domain);
    currentChartRef.current?.setXDomain(domain);
  }, [searchParams]);

  const windows = useMemo<CommissioningWindowSummary[]>(
    () => (Array.isArray(windowsQuery.data) ? windowsQuery.data : []),
    [windowsQuery.data],
  );

  const baselines = useMemo<DeviceBaselineSummary[]>(
    () => (Array.isArray(baselinesQuery.data) ? baselinesQuery.data : []),
    [baselinesQuery.data],
  );

  const deltaCompare = useBaselineCompare(deviceId, 'delta_t', xDomain);
  const copCompare = useBaselineCompare(deviceId, 'cop', xDomain);
  const currentCompare = useBaselineCompare(deviceId, 'current', xDomain);

  const lastWindow = useMemo<CommissioningWindowSummary | null>(() => {
    for (const window of windows) {
      if (ensureFiniteRange(window)) {
        return window;
      }
    }
    return null;
  }, [windows]);

  const measurementWindow = useMemo(() => ensureFiniteRange(lastWindow), [lastWindow]);

  const updateFocusParams = useCallback(
    (start: number, end: number) => {
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return;
      }
      const next = new URLSearchParams(searchParams);
      next.set('focus_start', String(Math.round(start)));
      next.set('focus_end', String(Math.round(end)));
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const onDomainChange = useCallback((domain: [number, number] | null) => {
    setXDomain((current) => {
      if (!domain && !current) {
        return current;
      }
      if (!domain || !current) {
        return domain;
      }
      if (current[0] === domain[0] && current[1] === domain[1]) {
        return current;
      }
      return domain;
    });
  }, []);

  const focusWindow = useCallback(
    (window: CommissioningWindowSummary | null | undefined) => {
      const range = ensureFiniteRange(window);
      if (!range) {
        return;
      }
      const span = Math.max(1, range.end - range.start);
      const pad = Math.max(span * 0.15, 1_000);
      const domain: [number, number] = [range.start - pad, range.end + pad];
      deltaChartRef.current?.setXDomain(domain);
      copChartRef.current?.setXDomain(domain);
      currentChartRef.current?.setXDomain(domain);
      updateFocusParams(range.start, range.end);
    },
    [updateFocusParams],
  );

  const handleJumpToWindow = useCallback(() => {
    if (!lastWindow) {
      return;
    }
    focusWindow(lastWindow);
    toast.info('Focused 90 s measurement window');
  }, [focusWindow, lastWindow]);

  const handleCopyFocusLink = useCallback(async () => {
    if (!lastWindow) {
      return;
    }
    const range = ensureFiniteRange(lastWindow);
    if (!range) {
      return;
    }
    updateFocusParams(range.start, range.end);
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('focus_start', String(Math.round(range.start)));
      url.searchParams.set('focus_end', String(Math.round(range.end)));
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        toast.warning('Clipboard not available');
        return;
      }
      await navigator.clipboard.writeText(url.toString());
      toast.success('Link copied');
    } catch (error) {
      console.warn('Failed to copy focus link', error);
      toast.warning('Could not copy');
    }
  }, [lastWindow, updateFocusParams]);

  const handleSelectWindow = useCallback(
    (window: CommissioningWindowSummary) => {
      focusWindow(window);
    },
    [focusWindow],
  );

  const handleSetBaseline = useCallback(async () => {
    if (!lastWindow) {
      return;
    }
    setBaselineSaving(true);
    try {
      await apiFetch<{ ok: boolean; baseline_id: string }>(
        `/api/devices/${deviceId}/baselines`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'delta_t',
            sample: {
              median: lastWindow.sample?.delta_t_med ?? null,
              p25: lastWindow.sample?.p25 ?? null,
              p75: lastWindow.sample?.p75 ?? null,
              window_s: 90,
              captured_at: lastWindow.updated_at,
            },
            thresholds: lastWindow.thresholds ?? null,
            source_session_id: lastWindow.session_id,
            step_id: lastWindow.step_id,
          }),
        },
        authFetch,
      );
      toast.success('Baseline saved');
      setDrawerTab('baselines');
      await queryClient.invalidateQueries({ queryKey: ['dev:baselines', deviceId] });
      await queryClient.invalidateQueries({ queryKey: ['baseline:cmp', deviceId] });
    } catch (error) {
      console.error('Failed to save baseline', error);
      toast.error('Could not save baseline');
    } finally {
      setBaselineSaving(false);
    }
  }, [authFetch, deviceId, lastWindow, queryClient]);

  const invalidateBaselineQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['dev:baselines', deviceId] }),
      queryClient.invalidateQueries({ queryKey: ['baseline:cmp', deviceId] }),
    ]);
  }, [deviceId, queryClient]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- consumed via JSX props
  const handleBaselineSetGolden = useCallback(
    async (baselineId: string) => {
      setBaselineMutating(baselineId);
      try {
        await apiFetch(
          `/api/devices/${deviceId}/baselines/${baselineId}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ is_golden: true }),
          },
          authFetch,
        );
        toast.success('Baseline marked as golden');
        await invalidateBaselineQueries();
      } catch (error) {
        console.error('Failed to set golden baseline', error);
        toast.error('Could not update baseline');
      } finally {
        setBaselineMutating(null);
      }
    },
    [authFetch, deviceId, invalidateBaselineQueries],
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- consumed via JSX props
  const handleBaselineLabelChange = useCallback(
    async (baselineId: string, label: string | null) => {
      const normalized = label?.trim() ?? '';
      const nextValue = normalized.length ? normalized : null;
      const current = baselines.find((baseline) => baseline.baseline_id === baselineId);
      if ((current?.label ?? null) === nextValue) {
        return;
      }
      setBaselineMutating(baselineId);
      try {
        await apiFetch(
          `/api/devices/${deviceId}/baselines/${baselineId}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: nextValue }),
          },
          authFetch,
        );
        toast.success('Baseline label updated');
        await invalidateBaselineQueries();
      } catch (error) {
        console.error('Failed to update baseline label', error);
        toast.error('Could not update baseline');
      } finally {
        setBaselineMutating(null);
      }
    },
    [authFetch, baselines, deviceId, invalidateBaselineQueries],
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- consumed via JSX props
  const handleBaselineExpiryChange = useCallback(
    async (baselineId: string, expiresAt: string | null) => {
      const current = baselines.find((baseline) => baseline.baseline_id === baselineId);
      if ((current?.expires_at ?? null) === (expiresAt ?? null)) {
        return;
      }
      setBaselineMutating(baselineId);
      try {
        await apiFetch(
          `/api/devices/${deviceId}/baselines/${baselineId}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expires_at: expiresAt }),
          },
          authFetch,
        );
        toast.success('Baseline expiry updated');
        await invalidateBaselineQueries();
      } catch (error) {
        console.error('Failed to update baseline expiry', error);
        toast.error('Could not update baseline');
      } finally {
        setBaselineMutating(null);
      }
    },
    [authFetch, baselines, deviceId, invalidateBaselineQueries],
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- consumed via JSX props
  const handleBaselineDelete = useCallback(
    async (baselineId: string) => {
      setBaselineMutating(baselineId);
      try {
        await apiFetch(
          `/api/devices/${deviceId}/baselines/${baselineId}`,
          {
            method: 'DELETE',
          },
          authFetch,
        );
        toast.success('Baseline deleted');
        await invalidateBaselineQueries();
      } catch (error) {
        console.error('Failed to delete baseline', error);
        toast.error('Could not delete baseline');
      } finally {
        setBaselineMutating(null);
      }
    },
    [authFetch, deviceId, invalidateBaselineQueries],
  );

  const baselineBandBuilder = useMemo<BandOverlayBuilder | undefined>(() => {
    const sample = baselines[0]?.sample;
    if (!sample || sample.p25 == null || sample.p75 == null) {
      return undefined;
    }
    const lowerBound = sample.p25 as number;
    const upperBound = sample.p75 as number;
    return (xScale, yScale) => {
      const domain = deltaChartRef.current?.getXDomain();
      if (!domain) {
        return null;
      }
      const [x0, x1] = domain;
      if (!Number.isFinite(x0) || !Number.isFinite(x1)) {
        return null;
      }
      const upper: BandOverlay['upper'] = [
        [xScale(x0), yScale(upperBound)],
        [xScale(x1), yScale(upperBound)],
      ];
      const lower: BandOverlay['lower'] = [
        [xScale(x0), yScale(lowerBound)],
        [xScale(x1), yScale(lowerBound)],
      ];
      return { upper, lower, className: 'gb-chart-baseline-band' } satisfies BandOverlay;
    };
  }, [baselines, deltaChartRef]);

  const telemetryPoints = useMemo(() => telemetryQuery.data ?? [], [telemetryQuery.data]);

  const deltaSeries = useMemo(() => buildSeries(telemetryPoints, ['delta_t', 'deltaT', 'delta-t', 'DeltaT']), [
    telemetryPoints,
  ]);
  const copSeries = useMemo(() => buildSeries(telemetryPoints, ['cop', 'COP', 'cop_value']), [telemetryPoints]);
  const currentSeries = useMemo(
    () =>
      buildSeries(telemetryPoints, [
        'compressor_current',
        'compressorCurrent',
        'current',
        'amps',
        'compressor-amps',
      ]),
    [telemetryPoints],
  );

  const deltaRolling = useMemo<RollingPoint[]>(() => computeRolling(deltaSeries), [deltaSeries]);

  const alertWindows = useMemo<AlertWindow[]>(() => {
    const now = Date.now();
    const raw = alertWindowsQuery.data as
      | Array<Record<string, unknown>>
      | { results?: Array<Record<string, unknown>> }
      | undefined;
    const collection = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.results)
        ? raw.results
        : [];

    return collection
      .map<AlertWindow | null>((entry: Record<string, unknown>) => {
        const openedAt = extractTimestamp(entry, ['opened_at', 'started_at', 'start']);
        const closedAt = extractTimestamp(entry, ['closed_at', 'ended_at', 'end']);
        const start = openedAt != null ? Date.parse(openedAt) : Number.NaN;
        const end = closedAt != null ? Date.parse(closedAt) : now;
        if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
          return null;
        }
        const severity = typeof entry.severity === 'string' ? entry.severity.toLowerCase() : '';
        const kind: AlertWindow['kind'] = severity === 'critical' ? 'crit' : 'warn';
        const type = typeof entry.type === 'string' ? entry.type : undefined;
        const coverage = Number.isFinite(Number(entry.coverage)) ? Number(entry.coverage) : null;
        const drift = Number.isFinite(Number(entry.drift)) ? Number(entry.drift) : null;
        const window: AlertWindow = {
          start,
          end,
          kind,
          type,
          coverage,
          drift,
        };
        return window;
      })
      .filter((window): window is AlertWindow => window !== null);
  }, [alertWindowsQuery.data]);

  const latest = latestQuery.data;
  const onlineValue = latestQuery.isLoading
    ? 'Loading…'
    : latestQuery.isError
      ? 'Unknown'
      : latest?.status.online === false
        ? 'Offline'
        : latest
          ? 'Online'
          : '—';
  const modeValue = latestQuery.isLoading
    ? 'Loading…'
    : latestQuery.isError
      ? '—'
      : latest?.status.mode ?? '—';

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Device {deviceId}</h2>
          <p className="page__subtitle">Live telemetry and state snapshot</p>
        </div>
        <div className="chip-group">
          {TELEMETRY_RANGES.map((option) => (
            <button
              key={option}
              className={`pill${range === option ? ' is-active' : ''}`}
              onClick={() => setRange(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </header>
      <section className="dashboard" style={{ marginBottom: '1.5rem' }}>
        <div className="card kpi accent" style={{ gridColumn: 'span 4' }}>
          <div className="kpi">
            <div className="label">Online</div>
            <div className="value">{onlineValue}</div>
          </div>
        </div>
        <div className="card kpi" style={{ gridColumn: 'span 4' }}>
          <div className="kpi">
            <div className="label">Mode</div>
            <div className="value">{modeValue}</div>
          </div>
        </div>
        <div className="card" style={{ gridColumn: 'span 6' }}>
          <h3>Current status</h3>
          {latestQuery.isLoading ? (
            <p>Loading latest state…</p>
          ) : latestQuery.isError ? (
            <p className="card__error">Unable to load device state.</p>
          ) : latest ? (
            <ul className="kv-list">
              <li>
                <span>Sampled</span>
                <span>{new Date(latest.timestamp).toLocaleString()}</span>
              </li>
              {Object.entries(latest.metrics).map(([metric, value]) => (
                <li key={metric}>
                  <span>{metric}</span>
                  <span>{value ?? '—'}</span>
                </li>
              ))}
              {latest.status.mode ? (
                <li>
                  <span>Mode</span>
                  <span>{latest.status.mode}</span>
                </li>
              ) : null}
              <li>
                <span>Online</span>
                <span>{latest.status.online === false ? 'Offline' : 'Online'}</span>
              </li>
            </ul>
          ) : (
            <p>No telemetry yet.</p>
          )}
        </div>
        <div className="card" style={{ gridColumn: 'span 6' }}>
          <h3>Active faults</h3>
          {latest?.faults && latest.faults.length > 0 ? (
            <ul className="fault-list">
              {latest.faults.map((fault) => (
                <li key={fault.code} className={fault.active ? 'fault fault--active' : 'fault'}>
                  <span className="fault__code">{fault.code}</span>
                  <span className="fault__description">{fault.description ?? 'No description'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No active faults.</p>
          )}
        </div>
      </section>
      <section className="card">
        <h3>Telemetry ({range})</h3>
        {telemetryQuery.isLoading ? (
          <p>Loading telemetry…</p>
        ) : telemetryQuery.isError ? (
          <p className="card__error">Unable to load telemetry.</p>
        ) : telemetryPoints.length > 0 ? (
          <>
        <DeviceDetailCharts
          delta={deltaSeries}
          deltaRolling={deltaRolling}
          cop={copSeries}
          current={currentSeries}
          overlays={alertWindows}
          measurementWindow={measurementWindow}
          range={range}
          windows={windows}
          lastWindow={lastWindow}
          onJumpToWindow={handleJumpToWindow}
          onCopyFocusLink={handleCopyFocusLink}
          onSelectWindow={handleSelectWindow}
          onSetBaseline={handleSetBaseline}
          baselineSaving={baselineSaving}
          baselines={baselines}
          baselineDrawer={baselineDrawerState}
          baselineBandBuilder={baselineBandBuilder}
          deltaChartRef={deltaChartRef}
          copChartRef={copChartRef}
          currentChartRef={currentChartRef}
          deltaCompare={deltaCompare}
          copCompare={copCompare}
          currentCompare={currentCompare}
          drawerTab={drawerTab}
          onDrawerTabChange={setDrawerTab}
          onDomainChange={onDomainChange}
          onBaselineSetGolden={handleBaselineSetGolden}
          onBaselineLabelChange={handleBaselineLabelChange}
          onBaselineExpiryChange={handleBaselineExpiryChange}
          onBaselineDelete={handleBaselineDelete}
        />
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Metrics</th>
                </tr>
              </thead>
              <tbody>
                {telemetryPoints.slice(0, 20).map((point) => (
                  <tr key={point.timestamp}>
                    <td>{new Date(point.timestamp).toLocaleString()}</td>
                    <td>
                      <div className="kv-inline">
                        {Object.entries(point.metrics).map(([key, value]) => (
                          <span key={key}>
                            {key}: <strong>{value ?? '—'}</strong>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p>No telemetry points for the selected window.</p>
        )}
      </section>
    </div>
  );
}

function extractTimestamp(entry: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return undefined;
}

function buildSeries(points: TelemetryPoint[], metricKeys: string[]): SeriesPoint[] {
  return points
    .map((point) => {
      const ts = Date.parse(point.timestamp);
      if (Number.isNaN(ts)) {
        return null;
      }
      const raw = metricKeys
        .map((key) => point.metrics?.[key])
        .find((value) => value != null && Number.isFinite(Number(value)));
      if (raw == null) {
        return null;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return null;
      }
      return { ts, v: value } satisfies SeriesPoint;
    })
    .filter((entry): entry is SeriesPoint => Boolean(entry))
    .sort((a, b) => a.ts - b.ts);
}

function MinMaxBadges({ pts }: { pts: SeriesPoint[] }) {
  const stats = useMemo(() => {
    if (!pts.length) {
      return null as { min: number; max: number } | null;
    }
    const values = pts.map((point) => point.v);
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [pts]);

  if (!stats) {
    return null;
  }

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span className="chip">min {stats.min.toFixed(2)}</span>
      <span className="chip ok">max {stats.max.toFixed(2)}</span>
    </div>
  );
}

function BaselineCompareChips({
  result,
  unit,
  precision = 1,
}: {
  result: BaselineCompareResult;
  unit: string;
  precision?: number;
}) {
  if (result.isLoading) {
    return <span className="chip">Loading…</span>;
  }
  if (result.isError) {
    return <span className="chip crit">Compare failed</span>;
  }
  if (result.isFetching && !result.data) {
    return <span className="chip">Checking…</span>;
  }
  const data = result.data;
  if (!data?.hasBaseline) {
    return <span className="chip">No baseline</span>;
  }
  const coverage = Number.isFinite(data.coverage) ? data.coverage ?? 0 : 0;
  const coveragePct = Math.round((coverage || 0) * 100);
  const drift = typeof data.drift === 'number' && Number.isFinite(data.drift) ? data.drift : null;
  return (
    <>
      <span className="chip ok" title="Fraction of points within baseline IQR">
        {coveragePct}% in-range
      </span>
      {drift != null ? (
        <span
          className={`chip ${drift >= 0 ? 'crit' : 'ok'}`}
          title="Median drift vs baseline"
        >
          {drift >= 0 ? '+' : ''}
          {drift.toFixed(precision)}
          {unit} vs baseline
        </span>
      ) : null}
    </>
  );
}

interface DeviceDetailChartsProps {
  delta: SeriesPoint[];
  deltaRolling: RollingPoint[];
  cop: SeriesPoint[];
  current: SeriesPoint[];
  overlays: AlertWindow[];
  measurementWindow: { start: number; end: number } | null;
  range: '24h' | '7d';
  windows: CommissioningWindowSummary[];
  lastWindow: CommissioningWindowSummary | null;
  onJumpToWindow: () => void;
  onCopyFocusLink: () => void;
  onSelectWindow: (window: CommissioningWindowSummary) => void;
  onSetBaseline: () => void;
  baselineSaving: boolean;
  baselines: DeviceBaselineSummary[];
  baselineDrawer: {
    busyId: string | null;
    suggestion: BaselineSuggestResponse | null;
    onSuggest: (kind: BaselineSuggestionKind) => void;
    onApply: (config: (typeof SUGGESTION_CONFIG)[number], warn: number, crit: number) => Promise<void>;
    summary: string | null;
  };
  baselineBandBuilder?: BandOverlayBuilder;
  deltaChartRef: RefObject<SeriesChartHandle>;
  copChartRef: RefObject<SeriesChartHandle>;
  currentChartRef: RefObject<SeriesChartHandle>;
  deltaCompare: BaselineCompareResult;
  copCompare: BaselineCompareResult;
  currentCompare: BaselineCompareResult;
  drawerTab: 'checks' | 'baselines';
  onDrawerTabChange: (tab: 'checks' | 'baselines') => void;
  onDomainChange: (domain: [number, number] | null) => void;
  onBaselineSetGolden: (baselineId: string) => void;
  onBaselineLabelChange: (baselineId: string, label: string | null) => void;
  onBaselineExpiryChange: (baselineId: string, expiresAt: string | null) => void;
  onBaselineDelete: (baselineId: string) => void;
}

function DeviceDetailCharts({
  delta,
  deltaRolling,
  cop,
  current,
  overlays,
  measurementWindow,
  range,
  windows,
  lastWindow,
  onJumpToWindow,
  onCopyFocusLink,
  onSelectWindow,
  onSetBaseline,
  baselineSaving,
  baselines,
  baselineDrawer,
  baselineBandBuilder,
  deltaChartRef,
  copChartRef,
  currentChartRef,
  deltaCompare,
  copCompare,
  currentCompare,
  drawerTab,
  onDrawerTabChange,
  onDomainChange,
  onBaselineSetGolden,
  onBaselineLabelChange,
  onBaselineExpiryChange,
  onBaselineDelete,
}: DeviceDetailChartsProps) {
  const hasSeries = delta.length > 0 || cop.length > 0 || current.length > 0;
  const measurementWindows: TimeWindow[] = measurementWindow
    ? [{ start: measurementWindow.start, end: measurementWindow.end, kind: 'info' }]
    : [];
  const hasMeasurementWindow = measurementWindows.length > 0;
  const measurementCaption = measurementWindow
    ? `90 s window from ${new Date(measurementWindow.start).toLocaleTimeString()} to ${new Date(
        measurementWindow.end,
      ).toLocaleTimeString()}.`
    : null;
  if (!hasSeries) {
    return <p>No trend data available for the selected window.</p>;
  }

  const jumpLatest = () => {
    if (overlays.length === 0) {
      return;
    }
    deltaChartRef.current?.focusLatestOverlay(overlays);
    copChartRef.current?.focusLatestOverlay(overlays);
    currentChartRef.current?.focusLatestOverlay(overlays);
  };

  const chartWidth = typeof window === 'undefined'
    ? 720
    : Math.max(320, Math.min(720, window.innerWidth - 120));
  const chartHeight = 160;
  const hasOverlays = overlays.length > 0;
  const baselineOverlay = useMemo<AlertWindow | null>(() => {
    let latest: AlertWindow | null = null;
    for (const window of overlays) {
      if (window.type !== 'baseline_deviation') {
        continue;
      }
      if (!latest || window.end > latest.end) {
        latest = window;
      }
    }
    return latest;
  }, [overlays]);

  const baselineSummary = useMemo(() => {
    if (!baselineOverlay) {
      return null as { coverage: number | null; drift: number | null } | null;
    }
    const coverage =
      typeof baselineOverlay.coverage === 'number' && Number.isFinite(baselineOverlay.coverage)
        ? Math.round(baselineOverlay.coverage * 100)
        : null;
    const drift =
      typeof baselineOverlay.drift === 'number' && Number.isFinite(baselineOverlay.drift)
        ? baselineOverlay.drift
        : null;
    return { coverage, drift };
  }, [baselineOverlay]);

  const baselineMetaText = useMemo(() => {
    if (!baselineSummary) {
      return '';
    }
    const parts: string[] = [];
    if (baselineSummary.coverage != null) {
      parts.push(`${baselineSummary.coverage}% in-range`);
    }
    if (baselineSummary.drift != null) {
      const signed = baselineSummary.drift >= 0
        ? `+${baselineSummary.drift.toFixed(1)}`
        : baselineSummary.drift.toFixed(1);
      parts.push(`drift ${signed}°C`);
    }
    return parts.length ? ` — ${parts.join('; ')}` : '';
  }, [baselineSummary]);

  const focusBaseline = useCallback(() => {
    if (!baselineOverlay) {
      return;
    }
    const end = baselineOverlay.end;
    const lookback = 10 * 60 * 1000;
    const start = Math.max(baselineOverlay.start, end - lookback);
    const domain: [number, number] = [start, end];
    deltaChartRef.current?.setXDomain(domain);
    copChartRef.current?.setXDomain(domain);
    currentChartRef.current?.setXDomain(domain);
  }, [baselineOverlay, copChartRef, currentChartRef, deltaChartRef]);

  const deltaBandOverlayBuilder = useMemo<BandOverlayBuilder | undefined>(
    () => mergeBandBuilders(createBandOverlayBuilder(deltaRolling), baselineBandBuilder),
    [baselineBandBuilder, deltaRolling],
  );

  const copRolling = useMemo<RollingPoint[]>(() => computeRolling(cop), [cop]);
  const currentRolling = useMemo<RollingPoint[]>(() => computeRolling(current), [current]);

  const copBandOverlayBuilder = useMemo<BandOverlayBuilder | undefined>(
    () => createBandOverlayBuilder(copRolling),
    [copRolling],
  );
  const currentBandOverlayBuilder = useMemo<BandOverlayBuilder | undefined>(
    () => createBandOverlayBuilder(currentRolling),
    [currentRolling],
  );

  const deltaRollingLookup = useMemo(() => {
    const map = new Map<number, RollingPoint>();
    for (const sample of deltaRolling) {
      map.set(sample.t, sample);
    }
    return map;
  }, [deltaRolling]);

  const deltaTooltipExtras = useCallback(
    (ts: number): string[] => {
      const sample = deltaRollingLookup.get(ts);
      if (!sample || sample.median == null) {
        return [];
      }
      return [`Median ΔT (90 s): ${sample.median.toFixed(1)}°C`];
    },
    [deltaRollingLookup],
  );
  const deltaTooltipExtrasFn = deltaRollingLookup.size ? deltaTooltipExtras : undefined;

  const hasWindows = windows.length > 0;
  const baselineLabel = baselineSaving ? 'Saving…' : 'Set as baseline';
  const {
    busyId: baselineDrawerBusyId,
    suggestion: baselineDrawerSuggestion,
    onSuggest: baselineDrawerOnSuggest,
    onApply: baselineDrawerOnApply,
    summary: baselineDrawerSummary,
  } = baselineDrawer;

  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        marginBottom: 24,
      }}
    >
      <div
        style={{
          flex: '1 1 640px',
          minWidth: 'min(640px, 100%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}
        >
          <h3 style={{ margin: 0 }}>Trends ({range})</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Legend
              ariaLabel="Trend severity legend"
              items={[
                { kind: 'ok', label: 'Normal trend' },
                { kind: 'warn', label: 'Warning window' },
                { kind: 'crit', label: 'Critical window' },
                {
                  kind: 'ok',
                  label: '90 s measurement window',
                  swatch: (size) => (
                    <svg className="chart-legend__swatch" width={size} height={size} aria-hidden>
                      <rect
                        x={2}
                        y={2}
                        width={size - 4}
                        height={size - 4}
                        className="gb-window-info"
                        rx={size / 6}
                      />
                    </svg>
                  ),
                },
                {
                  kind: 'ok',
                  label: '90 s median (IQR)',
                  swatch: (size) => (
                    <svg className="chart-legend__swatch" width={size} height={size} aria-hidden>
                      <rect
                        x={2}
                        y={size / 4}
                        width={size - 4}
                        height={size / 2}
                        className="gb-chart-median-band"
                        rx={size / 6}
                      />
                    </svg>
                  ),
                },
              ]}
            />
            {baselineOverlay ? (
              <button
                type="button"
                className="pill pill--glow"
                onClick={focusBaseline}
                title="Focus the charts on the most recent baseline deviation"
              >
                {`Baseline deviation${baselineMetaText}`}
              </button>
            ) : null}
            <button
              type="button"
              className={`pill${hasOverlays ? ' is-active' : ''}`}
              onClick={jumpLatest}
              disabled={!hasOverlays}
            >
              Jump to active alert
            </button>
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <strong>ΔT</strong>
              <MinMaxBadges pts={delta} />
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <BaselineCompareChips result={deltaCompare} unit="°C" precision={1} />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-pill"
                  onClick={onJumpToWindow}
                  disabled={!hasMeasurementWindow}
                >
                  Jump to 90 s check
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={onCopyFocusLink}
                  disabled={!lastWindow}
                >
                  Copy focus link
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={onSetBaseline}
                  disabled={!lastWindow || baselineSaving}
                  aria-busy={baselineSaving}
                >
                  {baselineLabel}
                </button>
              </div>
            </div>
          </div>
          <SeriesChart
            ref={deltaChartRef}
            data={delta}
            width={chartWidth}
            height={chartHeight}
            overlays={overlays}
            timeWindows={measurementWindows}
            stroke="var(--gb-chart-ok)"
            areaKind="ok"
            ariaLabel="Delta T trend with alert overlays"
            bandOverlayBuilder={deltaBandOverlayBuilder}
            tooltipExtras={deltaTooltipExtrasFn}
            onXDomainChange={onDomainChange}
          />
          {measurementCaption ? (
            <p className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>
              {measurementCaption}
            </p>
          ) : null}
        </div>

        <div style={{ marginTop: 8 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <strong>COP</strong>
              <MinMaxBadges pts={cop} />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <BaselineCompareChips result={copCompare} unit="×" precision={2} />
            </div>
          </div>
          <SeriesChart
            ref={copChartRef}
            data={cop}
            width={chartWidth}
            height={chartHeight}
            overlays={overlays}
            timeWindows={measurementWindows}
            stroke="var(--gb-chart-warn)"
            areaKind="warn"
            ariaLabel="COP trend with alert overlays"
            bandOverlayBuilder={copBandOverlayBuilder}
          />
        </div>

        <div style={{ marginTop: 8 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <strong>Compressor current</strong>
              <MinMaxBadges pts={current} />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <BaselineCompareChips result={currentCompare} unit="A" precision={1} />
            </div>
          </div>
          <SeriesChart
            ref={currentChartRef}
            data={current}
            width={chartWidth}
            height={chartHeight}
            overlays={overlays}
            timeWindows={measurementWindows}
            stroke="var(--gb-chart-warn)"
            areaKind="warn"
            ariaLabel="Compressor current trend with alert overlays"
            bandOverlayBuilder={currentBandOverlayBuilder}
          />
        </div>

        <small className="muted">
          Alert overlays remain shaded; the green band tracks the 90 s rolling median and interquartile range.
        </small>
      </div>

      <aside className="drawer" aria-label="Device tools">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            className={`pill${drawerTab === 'checks' ? ' is-active' : ''}`}
            onClick={() => onDrawerTabChange('checks')}
          >
            90 s checks
          </button>
          <button
            type="button"
            className={`pill${drawerTab === 'baselines' ? ' is-active' : ''}`}
            onClick={() => onDrawerTabChange('baselines')}
          >
            Baselines
          </button>
        </div>
        {drawerTab === 'baselines' ? (
          <>
            <h4 className="drawer-title">Baselines</h4>
            <BaselineSuggestionControls
              suggestion={baselineDrawerSuggestion}
              onSuggest={baselineDrawerOnSuggest}
              onApply={baselineDrawerOnApply}
            />
            {baselineDrawerSummary ? (
              <p className="muted" role="status" style={{ fontSize: '0.8rem' }}>
                {baselineDrawerSummary}
              </p>
            ) : null}
            <BaselineManagerList
              baselines={baselines}
              onSetGolden={onBaselineSetGolden}
              onLabelChange={onBaselineLabelChange}
              onExpiryChange={onBaselineExpiryChange}
              onDelete={onBaselineDelete}
              busyId={baselineDrawerBusyId}
            />
            {baselineDrawerBusyId ? (
              <p className="muted" role="status" style={{ fontSize: '0.75rem' }}>
                Updating baseline {baselineDrawerBusyId}…
              </p>
            ) : null}
          </>
        ) : (
          <>
            <h4 className="drawer-title">Recent 90 s checks</h4>
            <ul className="drawer-list">
              {hasWindows ? (
                windows.map((w) => (
                  <li key={`${w.session_id}:${w.step_id}`}>
                    <button
                      type="button"
                      onClick={() => onSelectWindow(w)}
                      className={`chip ${w.pass ? 'ok' : 'crit'}`}
                    >
                      {new Date(w.updated_at).toLocaleTimeString()} · {w.pass ? 'Pass' : 'Fail'}
                    </button>
                  </li>
                ))
              ) : (
                <li className="drawer-empty muted">No commissioning windows</li>
              )}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}

interface BaselineSuggestionControlsProps {
  suggestion: BaselineSuggestResponse | null;
  onSuggest: (kind: BaselineSuggestionKind) => void;
  onApply: (config: (typeof SUGGESTION_CONFIG)[number], warn: number, crit: number) => Promise<void>;
}

function BaselineSuggestionControls({ suggestion, onSuggest, onApply }: BaselineSuggestionControlsProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
      {SUGGESTION_CONFIG.map((config) => {
        const isActive = suggestion?.kind === config.kind;
        const suggestions = isActive ? suggestion?.suggestions : undefined;
        const hasSuggestion = Boolean(isActive && suggestion?.hasBaseline && suggestions);
        const noBaseline = isActive && suggestion?.hasBaseline === false;
        const noSamples = isActive && suggestion?.hasBaseline && !suggestions;
        const units = isActive && suggestion?.units ? suggestion.units : '';
        const coverage = isActive ? suggestion?.recent?.coverage : undefined;
        const coveragePct = typeof coverage === 'number' && Number.isFinite(coverage)
          ? Math.round(coverage * 100)
          : 0;

        return (
          <div key={config.kind} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-outline" onClick={() => onSuggest(config.kind)}>
                {`Suggest ${config.label} thresholds`}
              </button>
              {noBaseline ? (
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  No baseline found
                </span>
              ) : null}
              {noSamples ? (
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  No recent telemetry in window
                </span>
              ) : null}
            </div>
            {hasSuggestion && suggestions ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.85rem' }}>
                <span>
                  Recent coverage: {coveragePct}% in-range · Drift warn {suggestions.drift_warn}
                  {units} / crit {suggestions.drift_crit}
                  {units}
                </span>
                <button
                  type="button"
                  className="btn btn-pill"
                  onClick={() => {
                    void onApply(config, suggestions.drift_warn, suggestions.drift_crit);
                  }}
                >
                  Apply
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface BaselineManagerListProps {
  baselines: DeviceBaselineSummary[];
  onSetGolden: (baselineId: string) => void;
  onLabelChange: (baselineId: string, label: string | null) => void;
  onExpiryChange: (baselineId: string, expiresAt: string | null) => void;
  onDelete: (baselineId: string) => void;
  busyId: string | null;
}

function BaselineManagerList({
  baselines,
  onSetGolden,
  onLabelChange,
  onExpiryChange,
  onDelete,
  busyId,
}: BaselineManagerListProps) {
  if (!baselines.length) {
    return <p className="drawer-empty muted">No baselines yet</p>;
  }
  return (
    <ul className="drawer-list">
      {baselines.map((baseline) => {
        const busy = busyId === baseline.baseline_id;
        const labelInputId = `baseline-label-${baseline.baseline_id}`;
        const expiryInputId = `baseline-expiry-${baseline.baseline_id}`;
        const expiryValue = toLocalDateTimeInput(baseline.expires_at);
        const handleDelete = () => {
          if (typeof window !== 'undefined' && !window.confirm('Delete this baseline?')) {
            return;
          }
          onDelete(baseline.baseline_id);
        };
        return (
          <li key={baseline.baseline_id} aria-busy={busy} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <strong>{baseline.label || 'Baseline'}</strong>
                <div className="muted" style={{ fontSize: '0.75rem' }}>
                  {new Date(baseline.created_at).toLocaleString()}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {baseline.is_golden ? (
                  <span className="chip ok">Golden</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-pill"
                    onClick={() => onSetGolden(baseline.baseline_id)}
                    disabled={busy}
                  >
                    Set golden
                  </button>
                )}
                {baseline.expires_at ? (
                  <span className="chip crit">
                    Expires {new Date(baseline.expires_at).toLocaleDateString()}
                  </span>
                ) : (
                  <span className="chip">No expiry</span>
                )}
              </div>
            </div>
            <label htmlFor={labelInputId} className="muted" style={{ fontSize: '0.75rem' }}>
              Label
            </label>
            <input
              key={`${baseline.baseline_id}-label-${baseline.label ?? ''}`}
              id={labelInputId}
              type="text"
              defaultValue={baseline.label ?? ''}
              onBlur={(event) => onLabelChange(baseline.baseline_id, event.target.value)}
              disabled={busy}
              style={{ width: '100%' }}
            />
            <label htmlFor={expiryInputId} className="muted" style={{ fontSize: '0.75rem' }}>
              Expiry
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                key={`${baseline.baseline_id}-expiry-${expiryValue ?? 'none'}`}
                id={expiryInputId}
                type="datetime-local"
                defaultValue={expiryValue ?? ''}
                onBlur={(event) => onExpiryChange(baseline.baseline_id, fromLocalDateTimeInput(event.target.value))}
                disabled={busy}
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => onExpiryChange(baseline.baseline_id, null)}
                disabled={busy}
              >
                Clear
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-outline" onClick={handleDelete} disabled={busy}>
                Delete
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function toLocalDateTimeInput(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const pad = (input: number) => String(input).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function fromLocalDateTimeInput(value: string): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function computeRolling(series: SeriesPoint[]): RollingPoint[] {
  if (!series.length) {
    return [];
  }
  return rollingStats(
    series.map((point) => ({ t: point.ts, y: point.v })),
    90_000,
  );
}

function createBandOverlayBuilder(samples: RollingPoint[]): BandOverlayBuilder | undefined {
  if (!samples.length) {
    return undefined;
  }
  return (xScale, yScale) => buildBandFromRolling(samples, xScale, yScale);
}

function buildBandFromRolling(
  samples: RollingPoint[],
  xScale: (value: number) => number,
  yScale: (value: number) => number,
): ReturnType<BandOverlayBuilder> {
  const upper: Array<[number, number]> = [];
  const lower: Array<[number, number]> = [];
  for (const sample of samples) {
    if (sample.median == null) {
      continue;
    }
    const upperValue = sample.p75 ?? sample.median;
    const lowerValue = sample.p25 ?? sample.median;
    if (!Number.isFinite(upperValue) || !Number.isFinite(lowerValue)) {
      continue;
    }
    const xCoord = xScale(sample.t);
    upper.push([xCoord, yScale(upperValue)]);
    lower.push([xCoord, yScale(lowerValue)]);
  }
  if (!upper.length || !lower.length) {
    return null;
  }
  return { upper, lower, className: 'gb-chart-median-band' };
}

function mergeBandBuilders(
  ...builders: Array<BandOverlayBuilder | null | undefined>
): BandOverlayBuilder | undefined {
  const active = builders.filter(Boolean) as BandOverlayBuilder[];
  if (!active.length) {
    return undefined;
  }
  return (xScale, yScale) => {
    const overlays: BandOverlay[] = [];
    for (const builder of active) {
      const result = builder(xScale, yScale);
      if (!result) {
        continue;
      }
      if (Array.isArray(result)) {
        overlays.push(...result.filter(Boolean) as BandOverlay[]);
      } else {
        overlays.push(result);
      }
    }
    return overlays.length ? overlays : null;
  };
}

function ensureFiniteRange(
  window: CommissioningWindowSummary | null | undefined,
): { start: number; end: number } | null {
  if (!window) {
    return null;
  }
  const { start, end } = window;
  if (typeof start !== 'number' || typeof end !== 'number') {
    return null;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return { start, end };
}

export { BaselineCompareChips };
