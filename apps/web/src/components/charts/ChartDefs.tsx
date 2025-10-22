import { chartPalette } from './palette';

export function warnPatternId(baseId: string): string {
  return `${baseId}-warn-diag`;
}

export function critPatternId(baseId: string): string {
  return `${baseId}-crit-diag`;
}

export function ChartDefs({ id }: { id: string }) {
  const palette = chartPalette();

  return (
    <defs>
      <pattern
        id={warnPatternId(id)}
        patternUnits="userSpaceOnUse"
        width={6}
        height={6}
        patternTransform="rotate(45)"
      >
        <rect width={6} height={6} fill={palette.alpha(palette.warn, 0.16)} />
        <rect x={0} y={0} width={2} height={6} fill={palette.alpha(palette.warn, 0.45)} />
      </pattern>
      <pattern
        id={critPatternId(id)}
        patternUnits="userSpaceOnUse"
        width={6}
        height={6}
        patternTransform="rotate(45)"
      >
        <rect width={6} height={6} fill={palette.alpha(palette.crit, 0.18)} />
        <rect x={0} y={0} width={2} height={6} fill={palette.alpha(palette.crit, 0.5)} />
      </pattern>
    </defs>
  );
}
