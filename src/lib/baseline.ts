export function compareToIqr(values: number[], p25: number, p75: number) {
  const inside = values.filter((value) => value >= p25 && value <= p75).length;
  const coverage = values.length ? inside / values.length : 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : Number.NaN;
  return { coverage, median };
}
