export type ChartKind = 'ok' | 'warn' | 'crit';

export interface ChartPalette {
  ok: string;
  warn: string;
  crit: string;
  grid: string;
  text: string;
  alpha: (color: string | undefined, opacity: number) => string;
  pick: (kind: ChartKind) => string;
}

const FALLBACK: Omit<ChartPalette, 'alpha' | 'pick'> = {
  ok: '#39b54a',
  warn: '#e9b949',
  crit: '#f25f5c',
  grid: 'rgba(65, 64, 66, 0.18)',
  text: 'rgba(65, 64, 66, 0.72)',
};

export function chartPalette(root?: HTMLElement | null): ChartPalette {
  if (typeof window === 'undefined') {
    return buildPalette(FALLBACK);
  }

  const target = root ?? document.documentElement;
  const styles = getComputedStyle(target);

  const base = {
    ok: readVar(styles, '--gb-chart-ok', FALLBACK.ok),
    warn: readVar(styles, '--gb-chart-warn', FALLBACK.warn),
    crit: readVar(styles, '--gb-chart-crit', FALLBACK.crit),
    grid: readVar(styles, '--gb-chart-grid', FALLBACK.grid),
    text: readVar(styles, '--gb-chart-text', FALLBACK.text),
  } as const;

  return buildPalette(base);
}

function buildPalette(base: typeof FALLBACK): ChartPalette {
  const palette: ChartPalette = {
    ok: base.ok,
    warn: base.warn,
    crit: base.crit,
    grid: base.grid,
    text: base.text,
    alpha: (color, opacity) => withAlpha(color ?? base.ok, opacity),
    pick: (kind) => base[kind],
  };

  return palette;
}

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name);
  return value?.trim() || fallback;
}

function withAlpha(color: string, opacity: number): string {
  const value = clamp(opacity, 0, 1);
  const trimmed = color.trim();

  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed)) {
    const { r, g, b } = hexToRgb(trimmed);
    return `rgba(${r}, ${g}, ${b}, ${value})`;
  }

  const rgbMatch = trimmed.match(/^rgb\s*\(([^)]+)\)$/i);
  if (rgbMatch?.[1]) {
    const components = rgbMatch[1].split(',').map((part) => Number.parseFloat(part.trim()));
    const [r, g, b] = components as [number | undefined, number | undefined, number | undefined];
    return `rgba(${safeNumber(r)}, ${safeNumber(g)}, ${safeNumber(b)}, ${value})`;
  }

  const rgbaMatch = trimmed.match(/^rgba\s*\(([^)]+)\)$/i);
  if (rgbaMatch?.[1]) {
    const components = rgbaMatch[1]
      .split(',')
      .slice(0, 3)
      .map((part) => Number.parseFloat(part.trim()));
    const [r, g, b] = components as [number | undefined, number | undefined, number | undefined];
    return `rgba(${safeNumber(r)}, ${safeNumber(g)}, ${safeNumber(b)}, ${value})`;
  }

  // Fallback to color-mix when parsing fails.
  const pct = Math.round(value * 100);
  return `color-mix(in srgb, ${trimmed} ${pct}%, transparent)`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((ch) => ch + ch).join('')
    : normalized;
  const intVal = Number.parseInt(expanded, 16);
  const r = (intVal >> 16) & 255;
  const g = (intVal >> 8) & 255;
  const b = intVal & 255;
  return { r, g, b };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
