import React, { useId } from 'react';

type SparklineProps = {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
};

export function Sparkline({ data, width = 240, height = 60, color = '#0ea5e9', strokeWidth = 2 }: SparklineProps) {
  const gradientId = `spark-${useId().replace(/[:]/g, '')}`;
  if (!data.length) {
    return (
      <div style={{ padding: 12, color: '#64748b', fontSize: 12 }}>
        No data yet
      </div>
    );
  }

  const padding = 8;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((value, index) => {
    const x = padding + (index / Math.max(data.length - 1, 1)) * (width - padding * 2);
    const y = padding + (1 - (value - min) / range) * (height - padding * 2);
    return [x, y] as const;
  });

  const path = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');

  const last = points.at(-1);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`${path} L ${width - padding} ${height - padding} L ${padding} ${height - padding} Z`}
        fill={`url(#${gradientId})`}
        opacity={0.5}
      />
      <path d={path} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" />
      {last ? <circle cx={last[0]} cy={last[1]} r={3} fill={color} stroke="#fff" strokeWidth={1.5} /> : null}
    </svg>
  );
}
