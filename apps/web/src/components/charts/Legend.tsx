import { useId, useMemo } from 'react';
import { ChartDefs, critPatternId, warnPatternId } from './ChartDefs';
import { chartPalette, type ChartKind } from './palette';

export interface LegendItem {
  kind: ChartKind;
  label: string;
  hint?: string;
}

interface LegendProps {
  items?: LegendItem[];
  className?: string;
  ariaLabel?: string;
}

const DEFAULT_ITEMS: LegendItem[] = [
  { kind: 'ok', label: 'Normal' },
  { kind: 'warn', label: 'Warning' },
  { kind: 'crit', label: 'Critical' },
];

export function Legend({ items = DEFAULT_ITEMS, className = '', ariaLabel }: LegendProps) {
  const rawId = useId();
  const baseId = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ''), [rawId]);
  const palette = chartPalette();
  const legendItems = items.filter((item): item is LegendItem => Boolean(item));

  if (legendItems.length === 0) {
    return null;
  }

  return (
    <div className={`chart-legend${className ? ` ${className}` : ''}`} role="list" aria-label={ariaLabel}>
      <ChartDefs id={baseId} />
      {legendItems.map((item) => {
        const fill = (() => {
          if (item.kind === 'warn') {
            return `url(#${warnPatternId(baseId)})`;
          }
          if (item.kind === 'crit') {
            return `url(#${critPatternId(baseId)})`;
          }
          return palette.pick(item.kind);
        })();

        const stroke = palette.pick(item.kind);

        return (
          <div key={item.label} className="chart-legend__item" role="listitem">
            <svg className="chart-legend__swatch" width={18} height={18} aria-hidden>
              <rect width={18} height={18} fill={fill} stroke={stroke} strokeWidth={1} rx={6} ry={6} />
            </svg>
            <span className="chart-legend__label">{item.label}</span>
            {item.hint ? <span className="chart-legend__hint">{item.hint}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
