import React from 'react';

type SparklineProps = {
  data: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
};

export function Sparkline({
  data,
  width = 160,
  height = 40,
  strokeWidth = 2,
}: SparklineProps) {
  if (!data?.length) {
    return <svg width={width} height={height} />;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const step = data.length > 1 ? width / (data.length - 1) : 0;

  const d = data
    .map((value, index) => {
      const x = Number((index * step).toFixed(1));
      const y = Number((height - ((value - min) / span) * height).toFixed(1));
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={strokeWidth} />
    </svg>
  );
}
