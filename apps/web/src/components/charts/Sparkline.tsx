import { useId, type CSSProperties } from 'react';

interface SparklineProps {
  label: string;
  values: number[];
  formatValue?: (value: number) => string;
  color?: string;
  style?: CSSProperties;
}

export function Sparkline({ label, values, formatValue, color = '#0ea5e9', style }: SparklineProps): JSX.Element {
  const gradientId = useId();
  const latest = values.at(-1) ?? 0;
  const formatted = formatValue ? formatValue(latest) : latest.toFixed(2);
  const width = 240;
  const height = 64;
  const padding = 8;

  const min = Math.min(...values, latest);
  const max = Math.max(...values, latest);
  const range = max - min || 1;

  const points = values.length
    ? values.map((value, index) => {
        const x = padding + (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
        const y = height - padding - ((value - min) / range) * (height - padding * 2);
        return [x, y] as const;
      })
    : ([
        [padding, height - padding] as const,
        [width - padding, height - padding] as const,
      ] as const);

  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0].toFixed(2)} ${point[1].toFixed(2)}`)
    .join(' ');

  const lastPoint = points.at(-1);

  return (
    <div className="sparkline" style={style}>
      <div className="sparkline__header">
        <span className="sparkline__label">{label}</span>
        <span className="sparkline__value">{formatted}</span>
      </div>
      <svg className="sparkline__chart" role="img" aria-label={`${label} trend`} viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.5" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d={`${path} L ${width - padding} ${height - padding} L ${padding} ${height - padding} Z`}
          fill={`url(#${gradientId})`}
          opacity="0.3"
        />
        <path d={path} stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" />
        {lastPoint ? <circle cx={lastPoint[0]} cy={lastPoint[1]} r={3} fill={color} stroke="#ffffff" strokeWidth={1.5} /> : null}
      </svg>
    </div>
  );
}
