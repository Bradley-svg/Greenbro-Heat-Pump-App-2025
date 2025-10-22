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

export interface SeriesChartHandle {
  focusTs: (ts: number) => void;
  focusLatestOverlay: (windows: AlertWindow[]) => void;
}

export function nearestIndex(xs: number[], x: number): number {
  if (xs.length === 0) {
    return 0;
  }
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.abs(x - xs[lo]) <= Math.abs(xs[hi] - x) ? lo : hi;
}

interface SeriesChartProps {
  data: SeriesPoint[];
  overlays?: AlertWindow[];
  width?: number;
  height?: number;
  pad?: number;
  stroke?: string;
  areaKind?: ChartKind;
  grid?: boolean;
  yDomain?: [number, number];
  ariaLabel?: string;
}

export const SeriesChart = forwardRef<SeriesChartHandle, SeriesChartProps>(function SeriesChart(
  {
    data,
    overlays = [],
    width = 640,
    height = 220,
    pad = 16,
    stroke,
    areaKind = 'ok',
    grid = true,
    yDomain,
    ariaLabel,
  }: SeriesChartProps,
  ref,
) {
  const rawId = useId();
  const baseId = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ''), [rawId]);
  const palette = chartPalette();

  const sorted = useMemo(() => [...data].sort((a, b) => a.ts - b.ts), [data]);
  const hasData = sorted.length > 0;
  const minTs = hasData ? sorted[0]!.ts : 0;
  const maxTs = hasData ? sorted.at(-1)!.ts : minTs + 1;
  const minV = yDomain?.[0] ?? (hasData ? Math.min(...sorted.map((d) => d.v)) : 0);
  const maxV = yDomain?.[1] ?? (hasData ? Math.max(...sorted.map((d) => d.v)) : 1);
  const widthInner = Math.max(width - pad * 2, 1);
  const heightInner = Math.max(height - pad * 2, 1);
  const spanTs = Math.max(maxTs - minTs, 1);
  const flatSeries = hasData && maxV === minV;
  const spanV = flatSeries ? 1 : Math.max(maxV - minV, 1);

  const ts = useMemo(() => sorted.map((point) => point.ts), [sorted]);

  const x = (t: number) => pad + ((t - minTs) / spanTs) * widthInner;
  const y = (value: number) =>
    pad + (flatSeries ? heightInner / 2 : heightInner - ((value - minV) / spanV) * heightInner);

  const pathData = hasData
    ? sorted.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.ts).toFixed(2)},${y(point.v).toFixed(2)}`).join(' ')
    : '';

  const areaPath = hasData
    ? `M${x(minTs).toFixed(2)},${(pad + heightInner).toFixed(2)} ` +
      sorted.map((point) => `L${x(point.ts).toFixed(2)},${y(point.v).toFixed(2)}`).join(' ') +
      ` L${x(maxTs).toFixed(2)},${(pad + heightInner).toFixed(2)} Z`
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

      <g>
        {overlaysToRender.map((overlay, index) => {
          const startX = x(overlay.start);
          const endX = x(overlay.end);
          const fill = overlay.kind === 'crit' ? `url(#${critPatternId(baseId)})` : `url(#${warnPatternId(baseId)})`;
          const strokeColorOverlay = palette.pick(overlay.kind);
          return (
            <rect
              key={`${overlay.kind}-${index}-${overlay.start}`}
              x={startX}
              y={pad}
              width={Math.max(endX - startX, 0)}
              height={heightInner}
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
          <path d={pathData} fill="none" stroke={strokeColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        </g>
      ) : null}

      {activePoint ? (
        <g>
          <line x1={x(activePoint.ts)} y1={pad} x2={x(activePoint.ts)} y2={pad + heightInner} stroke="#9fb2c6" strokeDasharray="3 3" />
          <circle cx={x(activePoint.ts)} cy={y(activePoint.v)} r={3} fill="#ffffff" stroke="#0b0e12" strokeWidth={1} />
          <g transform={`translate(${Math.min(x(activePoint.ts) + 8, width - 140)}, ${pad + 8})`}>
            <rect className="chart-tip" width={132} height={activeOverlay ? 44 : 28} rx={6} />
            <text className="chart-tip-text" x={8} y={18}>
              Value: {activePoint.v.toFixed(2)}
            </text>
            {activeOverlay ? (
              <text className="chart-tip-text" x={8} y={34}>
                {activeOverlay.kind === 'crit' ? 'Critical window' : 'Warning window'}
              </text>
            ) : null}
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
