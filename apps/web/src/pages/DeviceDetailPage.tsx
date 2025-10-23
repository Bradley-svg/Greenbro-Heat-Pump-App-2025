import { useCallback, useMemo, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import { useAuthFetch } from '@hooks/useAuthFetch';
import type { DeviceLatestState, TelemetryPoint } from '@api/types';
import { Legend } from '@components/charts/Legend';
import {
  SeriesChart,
  type AlertWindow,
  type BandOverlayBuilder,
  type SeriesChartHandle,
  type SeriesPoint,
  type TimeWindow,
} from '@components/charts/SeriesChart';
import { rollingStats, type RollingPoint } from '@utils/rolling';
import { toast } from '@app/providers/toast';

const TELEMETRY_RANGES: Array<'24h' | '7d'> = ['24h', '7d'];

interface CommissioningWindowResponse {
  ok: boolean;
  window: { t_start: string; t_end: string } | null;
  sample?: Record<string, unknown> | null;
  updated_at?: string | null;
}

export function DeviceDetailPage(): JSX.Element {
  const { deviceId } = useParams<{ deviceId: string }>();
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const authFetch = useAuthFetch();

  if (!deviceId) {
    return <Navigate to="/devices" replace />;
  }

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

  const commissioningWindowQuery = useQuery({
    queryKey: ['device', deviceId, 'commissioning-window'],
    queryFn: () =>
      apiFetch<CommissioningWindowResponse>(
        `/api/devices/${deviceId}/commissioning/window`,
        undefined,
        authFetch,
      ),
    enabled: !!deviceId,
    refetchInterval: 60_000,
  });

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
      .map((entry: Record<string, unknown>) => {
        const openedAt = extractTimestamp(entry, ['opened_at', 'started_at', 'start']);
        const closedAt = extractTimestamp(entry, ['closed_at', 'ended_at', 'end']);
        const start = openedAt != null ? Date.parse(openedAt) : Number.NaN;
        const end = closedAt != null ? Date.parse(closedAt) : now;
        if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
          return null;
        }
        const severity = typeof entry.severity === 'string' ? entry.severity.toLowerCase() : '';
        const kind: AlertWindow['kind'] = severity === 'critical' ? 'crit' : 'warn';
        return { start, end, kind } satisfies AlertWindow;
      })
      .filter((window): window is AlertWindow => Boolean(window));
  }, [alertWindowsQuery.data]);

  const measurementWindow = useMemo(() => {
    const raw = commissioningWindowQuery.data?.window;
    if (!raw) {
      return null as { start: number; end: number } | null;
    }
    const start = Date.parse(raw.t_start);
    const end = Date.parse(raw.t_end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }
    return { start, end };
  }, [commissioningWindowQuery.data]);

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

interface DeviceDetailChartsProps {
  delta: SeriesPoint[];
  deltaRolling: RollingPoint[];
  cop: SeriesPoint[];
  current: SeriesPoint[];
  overlays: AlertWindow[];
  measurementWindow: { start: number; end: number } | null;
  range: '24h' | '7d';
}

function DeviceDetailCharts({
  delta,
  deltaRolling,
  cop,
  current,
  overlays,
  measurementWindow,
  range,
}: DeviceDetailChartsProps) {
  const deltaChartRef = useRef<SeriesChartHandle>(null);
  const copChartRef = useRef<SeriesChartHandle>(null);
  const currentChartRef = useRef<SeriesChartHandle>(null);

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

  const jumpToMeasurementWindow = () => {
    if (!measurementWindow) {
      return;
    }
    const span = Math.max(1, measurementWindow.end - measurementWindow.start);
    const pad = Math.max(span * 0.15, 1_000);
    const domain: [number, number] = [
      measurementWindow.start - pad,
      measurementWindow.end + pad,
    ];
    deltaChartRef.current?.setXDomain(domain);
    copChartRef.current?.setXDomain(domain);
    currentChartRef.current?.setXDomain(domain);
    toast.info('Focused 90 s measurement window');
  };

  const chartWidth = typeof window === 'undefined'
    ? 720
    : Math.max(320, Math.min(720, window.innerWidth - 120));
  const chartHeight = 160;
  const hasOverlays = overlays.length > 0;

  const deltaBandOverlayBuilder = useMemo<BandOverlayBuilder | undefined>(
    () => createBandOverlayBuilder(deltaRolling),
    [deltaRolling],
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
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
          <button
            type="button"
            className="btn btn-pill"
            onClick={jumpToMeasurementWindow}
            disabled={!hasMeasurementWindow}
          >
            Jump to 90 s check
          </button>
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
        />
        {measurementCaption ? (
          <p className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>
            {measurementCaption}
          </p>
        ) : null}
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>COP</strong>
          <MinMaxBadges pts={cop} />
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Compressor current</strong>
          <MinMaxBadges pts={current} />
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
  );
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
