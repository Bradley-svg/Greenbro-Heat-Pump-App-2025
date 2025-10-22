import { useId, useMemo } from 'react';
import { ChartDefs, critPatternId, warnPatternId } from './ChartDefs';
import { chartPalette, type ChartKind } from './palette';

type SparklineProps = {
  data: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  kind?: ChartKind;
  showArea?: boolean;
  ariaLabel?: string;
};

export function Sparkline({
  data,
  width = 160,
  height = 40,
  strokeWidth = 2,
  kind = 'ok',
  showArea = false,
  ariaLabel,
}: SparklineProps) {
  const rawId = useId();
  const baseId = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ''), [rawId]);
  const palette = chartPalette();
  const hasData = Array.isArray(data) && data.length > 0;

  const { linePath, areaPath } = useMemo(() => {
    if (!hasData) {
      return { linePath: '', areaPath: undefined as string | undefined };
    }

    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const step = data.length > 1 ? width / (data.length - 1) : 0;

    const points = data.map((value, index) => {
      const x = data.length > 1 ? index * step : width / 2;
      const y = height - ((value - min) / span) * height;
      return {
        x: Number(x.toFixed(1)),
        y: Number(y.toFixed(1)),
      };
    });

    const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');

    if (!showArea) {
      return { linePath: path, areaPath: undefined as string | undefined };
    }

    const first = points[0] ?? { x: 0, y: height };
    const last = points.at(-1) ?? { x: width, y: height };
    const area = `${path} L${last.x},${height} L${first.x},${height} Z`;

    return { linePath: path, areaPath: area };
  }, [data, hasData, height, showArea, width]);

  const gridLines = useMemo(() => {
    const ratios = [0.25, 0.5, 0.75];
    return ratios.map((ratio) => Number((height - ratio * height).toFixed(1)));
  }, [height]);

  const areaFill = useMemo(() => {
    if (!showArea || !areaPath) {
      return 'none';
    }
    if (kind === 'warn') {
      return `url(#${warnPatternId(baseId)})`;
    }
    if (kind === 'crit') {
      return `url(#${critPatternId(baseId)})`;
    }
    return palette.alpha(palette.pick(kind), 0.18);
  }, [areaPath, baseId, kind, palette, showArea]);

  return (
    <svg
      className={`spark ${kind}`}
      width={width}
      height={height}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <ChartDefs id={baseId} />
      {gridLines.map((y, index) => (
        <line key={`grid-${index}`} className="grid" x1={0} y1={y} x2={width} y2={y} />
      ))}
      <line className="axis" x1={0} y1={height - 1} x2={width} y2={height - 1} />
      {showArea && areaPath ? <path className={`area ${kind}`} d={areaPath} fill={areaFill} stroke="none" /> : null}
      {hasData ? (
        <path className="line" d={linePath} fill="none" stroke="currentColor" strokeWidth={strokeWidth} />
      ) : null}
    </svg>
  );
}
