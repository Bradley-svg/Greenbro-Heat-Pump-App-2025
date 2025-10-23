import React, { forwardRef, useCallback, useId, useImperativeHandle, useMemo, useState } from 'react';
import { ChartDefs, critPatternId, warnPatternId } from './ChartDefs';
import { chartPalette, type ChartKind } from './palette';

export interface SeriesPoint {
  ts: number;
  v: number;
}

export type OverlayKind = Extract<ChartKind, 'warn' | 'crit'>;

export interface AlertWindow {
  start: number;
  end: number;
  kind: OverlayKind;
}

export type TimeWindow = { start: number; end: number; kind?: 'info' | 'warn' | 'crit' };

type PathPt = [number, number];

export interface BandOverlay {
  lower: PathPt[];
  upper: PathPt[];
  className?: string;
}

type ScaleFn = (value: number) => number;
export type BandOverlayBuilder = (x: ScaleFn, y: ScaleFn) => BandOverlay | null | undefined;

const WINDOW_CLASS: Record<NonNullable<TimeWindow['kind']>, string> = {
  info: 'gb-window-info',
  warn: 'gb-window-warn',
  crit: 'gb-window-crit',
};

export interface SeriesChartHandle {
  focusTs: (ts: number) => void;
  focusLatestOverlay: (windows: AlertWindow[]) => void;
  setXDomain: (domain: [number, number] | null) => void;
}

export function nearestIndex(xs: number[], x: number): number {
  if (xs.length === 0) {
    return 0;
  }
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const midValue = xs[mid]!;
    if (midValue < x) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const loValue = xs[lo]!;
  const hiValue = xs[hi]!;
  return Math.abs(x - loValue) <= Math.abs(hiValue - x) ? lo : hi;
}

function pathFromPoints(points: PathPt[]) {
  if (points.length === 0) {
    return '';
  }
  const [firstX, firstY] = points[0]!;
  const tail = points
    .slice(1)
    .map(([px, py]) => `L${px},${py}`)
    .join(' ');
  return `M${firstX},${firstY}${tail ? ` ${tail}` : ''}`;
}

function bandPath(upper: PathPt[], lower: PathPt[]) {
  if (!upper.length || !lower.length) {
    return '';
  }
  const upperPath = pathFromPoints(upper);
  const lowerPath = pathFromPoints([...lower].reverse());
  if (!upperPath || !lowerPath) {
    return '';
  }
  return `${upperPath} ${lowerPath} Z`;
}

interface SeriesChartProps {
  data: SeriesPoint[];
  overlays?: AlertWindow[];
  timeWindows?: TimeWindow[];
  width?: number;
  height?: number;
  pad?: number;
  stroke?: string;
  areaKind?: ChartKind;
  grid?: boolean;
  yDomain?: [number, number];
  ariaLabel?: string;
  bandOverlay?: BandOverlay | null;
  bandOverlayBuilder?: BandOverlayBuilder;
  tooltipExtras?: (ts: number) => string[];
}

export const SeriesChart = forwardRef<SeriesChartHandle, SeriesChartProps>(function SeriesChart(
  {
    data,
    overlays = [],
    timeWindows = [],
    width = 640,
    height = 220,
    pad = 16,
    stroke,
    areaKind = 'ok',
    grid = true,
    yDomain,
    ariaLabel,
    bandOverlay: bandOverlayProp = null,
    bandOverlayBuilder,
    tooltipExtras,
  }: SeriesChartProps,
  ref,
) {
  const rawId = useId();
  const baseId = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ''), [rawId]);
  const palette = chartPalette();

  const sorted = useMemo(() => [...data].sort((a, b) => a.ts - b.ts), [data]);
  const hasData = sorted.length > 0;
  const dataMinTs = hasData ? sorted[0]!.ts : 0;
  const dataMaxTs = hasData ? sorted.at(-1)!.ts : dataMinTs + 1;

  const [xDomain, setXDomainState] = useState<[number, number] | null>(null);

  const [minTs, maxTs] = useMemo(() => {
    if (!xDomain) {
      if (dataMaxTs === dataMinTs) {
        return [dataMinTs, dataMinTs + 1] as const;
      }
      return [dataMinTs, dataMaxTs] as const;
    }
    const [start, end] = xDomain;
    const startFinite = Number.isFinite(start) ? start : dataMinTs;
    const endFinite = Number.isFinite(end) ? end : dataMaxTs;
    const lo = Math.min(startFinite, endFinite);
    const hi = Math.max(startFinite, endFinite);
    if (hi === lo) {
      return [lo, lo + 1] as const;
    }
    return [lo, hi] as const;
  }, [xDomain, dataMinTs, dataMaxTs]);
  const minV = yDomain?.[0] ?? (hasData ? Math.min(...sorted.map((d) => d.v)) : 0);
  const maxV = yDomain?.[1] ?? (hasData ? Math.max(...sorted.map((d) => d.v)) : 1);
  const widthInner = Math.max(width - pad * 2, 1);
  const heightInner = Math.max(height - pad * 2, 1);
  const spanTs = Math.max(maxTs - minTs, 1);
  const flatSeries = hasData && maxV === minV;
  const spanV = flatSeries ? 1 : Math.max(maxV - minV, 1);
  const plotTop = pad;
  const plotHeight = heightInner;

  const ts = useMemo(() => sorted.map((point) => point.ts), [sorted]);

  const xScale = useCallback(
    (t: number) => pad + ((t - minTs) / spanTs) * widthInner,
    [pad, minTs, spanTs, widthInner],
  );
  const yScale = useCallback(
    (value: number) =>
      pad + (flatSeries ? heightInner / 2 : heightInner - ((value - minV) / spanV) * heightInner),
    [flatSeries, heightInner, minV, pad, spanV],
  );

  const pathData = hasData
    ? sorted
        .map((point, index) =>
          `${index === 0 ? 'M' : 'L'}${xScale(point.ts).toFixed(2)},${yScale(point.v).toFixed(2)}`,
        )
        .join(' ')
    : '';

  const areaPath = hasData
    ? `M${xScale(minTs).toFixed(2)},${(pad + heightInner).toFixed(2)} ` +
      sorted.map((point) => `L${xScale(point.ts).toFixed(2)},${yScale(point.v).toFixed(2)}`).join(' ') +
      ` L${xScale(maxTs).toFixed(2)},${(pad + heightInner).toFixed(2)} Z`
    : '';

  const ticks = useMemo(() => {
    if (!hasData) {
      return [] as number[];
    }
    return Array.from({ length: 6 }, (_, index) => minTs + (index / 5) * (maxTs - minTs));
  }, [hasData, minTs, maxTs]);

  const overlaysToRender = useMemo(() => {
    if (!hasData) {
      return [] as AlertWindow[];
    }
    return overlays
      .map((window) => {
        const start = Math.max(window.start, minTs);
        const end = Math.min(window.end, maxTs);
        return end > start ? { ...window, start, end } : null;
      })
      .filter((window): window is AlertWindow => Boolean(window));
  }, [hasData, overlays, minTs, maxTs]);

  const windowsToRender = useMemo(() => {
    if (!timeWindows.length) {
      return [] as Array<TimeWindow & { kind: NonNullable<TimeWindow['kind']> }>;
    }
    return timeWindows
      .map((window) => {
        if (!Number.isFinite(window.start) || !Number.isFinite(window.end)) {
          return null;
        }
        const rawStart = Math.min(window.start, window.end);
        const rawEnd = Math.max(window.start, window.end);
        const start = Math.max(rawStart, minTs);
        const end = Math.min(rawEnd, maxTs);
        if (end <= start) {
          return null;
        }
        const kind = window.kind ?? 'info';
        return {
          ...window,
          start,
          end,
          kind,
        } as TimeWindow & { kind: NonNullable<TimeWindow['kind']> };
      })
      .filter((window): window is TimeWindow & { kind: NonNullable<TimeWindow['kind']> } => Boolean(window));
  }, [timeWindows, minTs, maxTs]);

  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const clampTs = useCallback((value: number) => Math.min(Math.max(value, minTs), maxTs), [minTs, maxTs]);
  const activeIndex = cursor == null || ts.length === 0 ? undefined : nearestIndex(ts, clampTs(cursor));
  const activePoint = activeIndex == null ? undefined : sorted[activeIndex];
  const activeOverlay = activePoint
    ? overlaysToRender.find((overlay) => activePoint.ts >= overlay.start && activePoint.ts <= overlay.end)
    : undefined;

  useImperativeHandle(
    ref,
    () => ({
      focusTs: (targetTs) => {
        if (!hasData) {
          return;
        }
        setCursor(clampTs(targetTs));
      },
      focusLatestOverlay: (windows) => {
        if (!hasData || !windows?.length) {
          return;
        }
        const latest = Math.max(...windows.map((window) => window.end));
        setCursor(clampTs(latest));
      },
      setXDomain: (domain) => {
        if (!domain) {
          setXDomainState(null);
          return;
        }
        const [start, end] = domain;
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          setXDomainState(null);
          return;
        }
        setXDomainState([start, end]);
      },
    }),
    [hasData, clampTs],
  );

  const areaFill = useMemo(() => {
    if (!hasData) {
      return 'none';
    }
    if (areaKind === 'warn') {
      return `url(#${warnPatternId(baseId)})`;
    }
    if (areaKind === 'crit') {
      return `url(#${critPatternId(baseId)})`;
    }
    return palette.alpha(palette.pick(areaKind), 0.12);
  }, [areaKind, baseId, hasData, palette]);

  const strokeColor = stroke ?? palette.pick(areaKind);

  const bandOverlayFromBuilder = useMemo(() => {
    if (!hasData || !bandOverlayBuilder) {
      return null;
    }
    return bandOverlayBuilder(xScale, yScale) ?? null;
  }, [bandOverlayBuilder, hasData, xScale, yScale]);

  const bandOverlay = bandOverlayProp ?? bandOverlayFromBuilder;

  const tooltipLines = activePoint
    ? (() => {
        const lines = [`Value: ${activePoint.v.toFixed(2)}`];
        if (activeOverlay) {
          lines.push(activeOverlay.kind === 'crit' ? 'Critical window' : 'Warning window');
        }
        if (tooltipExtras) {
          const extras = tooltipExtras(activePoint.ts) ?? [];
          if (Array.isArray(extras) && extras.length > 0) {
            lines.push(...extras);
          }
        }
        return lines;
      })()
    : [];
  const tooltipHeight = tooltipLines.length ? 12 + tooltipLines.length * 16 : 0;

  const handleMove = (event: React.MouseEvent<SVGRectElement>) => {
    if (!hasData) {
      return;
    }
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) {
      return;
    }
    const rect = svg.getBoundingClientRect();
    const relativeX = event.clientX - rect.left - pad;
    const ratio = Math.max(0, Math.min(1, relativeX / widthInner));
    const target = minTs + ratio * (maxTs - minTs);
    setCursor(clampTs(target));
  };

  const handleLeave = () => setCursor(undefined);

  const handleKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (!hasData) {
      return;
    }
    const delta = (maxTs - minTs) / 60;
    if (event.key === 'ArrowRight') {
      setCursor((current) => clampTs((current ?? minTs) + delta));
      event.preventDefault();
    } else if (event.key === 'ArrowLeft') {
      setCursor((current) => clampTs((current ?? minTs) - delta));
      event.preventDefault();
    } else if (event.key === 'Home') {
      setCursor(minTs);
      event.preventDefault();
    } else if (event.key === 'End') {
      setCursor(maxTs);
      event.preventDefault();
    }
  };

  return (
    <svg
      width={width}
      height={height}
      role={ariaLabel ? 'img' : 'presentation'}
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <ChartDefs id={baseId} />
      <g data-testid="xdomain" data-min={minTs} data-max={maxTs} aria-hidden="true" />
      {grid && hasData ? (
        <g className="chart-grid">
          {ticks.map((tick, index) => {
            if (maxTs === minTs) {
              return null;
            }
            const xPos = pad + ((tick - minTs) / (maxTs - minTs)) * widthInner;
            return <line key={index} x1={xPos} y1={pad} x2={xPos} y2={pad + heightInner} stroke={palette.grid} />;
          })}
        </g>
      ) : null}

      <g aria-hidden="true">
        {windowsToRender.map((window, index) => {
          const x1 = xScale(window.start);
          const x2 = xScale(window.end);
          const x = Math.min(x1, x2);
          const widthRect = Math.max(1, Math.abs(x2 - x1));
          return (
            <rect
              key={`tw-${index}`}
              x={x}
              y={plotTop}
              width={widthRect}
              height={plotHeight}
              className={WINDOW_CLASS[window.kind]}
              data-testid={`time-window-${index}`}
              aria-hidden="true"
            />
          );
        })}
      </g>

      <g>
        {overlaysToRender.map((overlay, index) => {
          const startX = xScale(overlay.start);
          const endX = xScale(overlay.end);
          const fill = overlay.kind === 'crit' ? `url(#${critPatternId(baseId)})` : `url(#${warnPatternId(baseId)})`;
          const strokeColorOverlay = palette.pick(overlay.kind);
          return (
            <rect
              key={`${overlay.kind}-${index}-${overlay.start}`}
              x={startX}
              y={plotTop}
              width={Math.max(endX - startX, 0)}
              height={plotHeight}
              fill={fill}
              stroke={strokeColorOverlay}
              opacity={0.95}
            />
          );
        })}
      </g>

      {hasData ? (
        <g>
          <path d={areaPath} fill={areaFill} stroke="none" />
          {bandOverlay && bandOverlay.upper.length && bandOverlay.lower.length ? (
            <path
              d={bandPath(bandOverlay.upper, bandOverlay.lower)}
              className={bandOverlay.className || 'gb-chart-median-band'}
            />
          ) : null}
          <path d={pathData} fill="none" stroke={strokeColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        </g>
      ) : null}

      {activePoint ? (
        <g>
          <line x1={xScale(activePoint.ts)} y1={pad} x2={xScale(activePoint.ts)} y2={pad + heightInner} stroke="#9fb2c6" strokeDasharray="3 3" />
          <circle cx={xScale(activePoint.ts)} cy={yScale(activePoint.v)} r={3} fill="#ffffff" stroke="#0b0e12" strokeWidth={1} />
          <g transform={`translate(${Math.min(xScale(activePoint.ts) + 8, width - 140)}, ${pad + 8})`}>
            <rect className="chart-tip" width={132} height={tooltipHeight || 28} rx={6} />
            {tooltipLines.map((line, index) => (
              <text key={index} className="chart-tip-text" x={8} y={18 + index * 16}>
                {line}
              </text>
            ))}
          </g>
        </g>
      ) : null}

      <rect
        x={pad}
        y={pad}
        width={widthInner}
        height={heightInner}
        fill="transparent"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      />
    </svg>
  );
});
