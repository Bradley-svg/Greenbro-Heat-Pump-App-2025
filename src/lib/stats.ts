export function median(values: number[]): number | null {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  if (n % 2) {
    const value = xs[mid];
    return typeof value === 'number' ? value : null;
  }
  const lower = xs[mid - 1];
  const upper = xs[mid];
  if (typeof lower !== 'number' || typeof upper !== 'number') {
    return null;
  }
  return (lower + upper) / 2;
}
