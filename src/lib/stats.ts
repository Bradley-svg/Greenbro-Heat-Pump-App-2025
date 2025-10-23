export function median(values: number[]): number | null {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
