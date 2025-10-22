import { useId, useMemo } from 'react';
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

export function SeriesChart({
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
}: SeriesChartProps) {
  const rawId = useId();
  const baseId = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ''), [rawId]);
  const palette = chartPalette();
  const hasData = data.length > 0;

  const [pathData, areaPath, bounds] = useMemo(() => {
    if (!hasData) {
      return ['', '', undefined as undefined | { minTs: number; maxTs: number; minV: number; maxV: number }];
    }

    const sorted = [...data].sort((a, b) => a.ts - b.ts);
    const minTs = sorted[0]?.ts ?? 0;
    const maxTs = sorted.at(-1)?.ts ?? minTs;
    const minV = yDomain ? yDomain[0] : Math.min(...sorted.map((d) => d.v));
    const maxV = yDomain ? yDomain[1] : Math.max(...sorted.map((d) => d.v));
    const widthInner = Math.max(width - pad * 2, 1);
    const heightInner = Math.max(height - pad * 2, 1);
    const tsSpan = maxTs - minTs || 1;
    const valueSpan = maxV - minV || 1;

    const x = (ts: number) => pad + ((ts - minTs) / tsSpan) * widthInner;
    const y = (value: number) => pad + (heightInner - ((value - minV) / valueSpan) * heightInner);

    const line = sorted
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.ts).toFixed(2)},${y(point.v).toFixed(2)}`)
      .join(' ');

    const area =
      `M${x(minTs).toFixed(2)},${(pad + heightInner).toFixed(2)} ` +
      sorted.map((point) => `L${x(point.ts).toFixed(2)},${y(point.v).toFixed(2)}`).join(' ') +
      ` L${x(maxTs).toFixed(2)},${(pad + heightInner).toFixed(2)} Z`;

    return [line, area, { minTs, maxTs, minV, maxV }];
  }, [data, hasData, height, pad, width, yDomain]);

  const ticks = useMemo(() => {
    if (!bounds) {
      return [] as number[];
    }
    const span = bounds.maxTs - bounds.minTs;
    if (span === 0) {
      return [bounds.minTs];
    }
    return Array.from({ length: 6 }, (_, index) => bounds.minTs + (index / 5) * span);
  }, [bounds]);

  const overlaysToRender = useMemo(() => {
    if (!bounds) {
      return [] as AlertWindow[];
    }
    return overlays
      .map((window) => {
        const clampedStart = Math.max(window.start, bounds.minTs);
        const clampedEnd = Math.min(window.end, bounds.maxTs);
        return clampedEnd > clampedStart ? { ...window, start: clampedStart, end: clampedEnd } : null;
      })
      .filter((window): window is AlertWindow => Boolean(window));
  }, [bounds, overlays]);

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

  return (
    <svg
      width={width}
      height={height}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <ChartDefs id={baseId} />
      {grid && bounds ? (
        <g className="chart-grid">
          {ticks.map((tick, index) => {
            if (bounds.maxTs === bounds.minTs) {
              return null;
            }
            const x = pad + ((tick - bounds.minTs) / (bounds.maxTs - bounds.minTs)) * Math.max(width - pad * 2, 1);
            return <line key={index} x1={x} y1={pad} x2={x} y2={height - pad} stroke={palette.grid} />;
          })}
        </g>
      ) : null}
      <g>
        {overlaysToRender.map((overlay, index) => {
          const tsSpan = bounds!.maxTs - bounds!.minTs || 1;
          const widthInner = Math.max(width - pad * 2, 1);
          const xStart = pad + ((overlay.start - bounds!.minTs) / tsSpan) * widthInner;
          const xEnd = pad + ((overlay.end - bounds!.minTs) / tsSpan) * widthInner;
          const overlayFill = overlay.kind === 'crit' ? `url(#${critPatternId(baseId)})` : `url(#${warnPatternId(baseId)})`;
          const overlayStroke = palette.pick(overlay.kind);
          return (
            <rect
              key={`${overlay.kind}-${index}`}
              x={xStart}
              y={pad}
              width={Math.max(xEnd - xStart, 0)}
              height={Math.max(height - pad * 2, 0)}
              fill={overlayFill}
              stroke={overlayStroke}
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
    </svg>
  );
}
