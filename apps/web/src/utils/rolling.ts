// Minimal rolling median/p25/p75 over a time window (default 90s).
// Uses a sorted multiset maintained via binary insert/remove.
// Complexity: O(n log k). Fine for typical chart sizes (<10k points).

export type XY = { t: number; y: number | null | undefined };
export type RollingPoint = { t: number; median: number | null; p25: number | null; p75: number | null };

function bisectLeft(values: number[], needle: number) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < needle) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function percentile(sorted: number[], pct: number) {
  if (sorted.length === 0) {
    return null;
  }
  const index = pct * (sorted.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) {
    return sorted[lo]!;
  }
  const weight = index - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * weight;
}

export function rollingStats(points: XY[], windowMs = 90_000): RollingPoint[] {
  const out: RollingPoint[] = [];
  const queue: XY[] = [];
  const values: number[] = [];
  let head = 0;

  for (const point of points) {
    // evict samples outside the rolling window
    while (head < queue.length && point.t - queue[head]!.t > windowMs) {
      const evicted = queue[head]!;
      if (evicted.y != null && !Number.isNaN(evicted.y)) {
        const idx = bisectLeft(values, evicted.y);
        if (idx < values.length && values[idx] === evicted.y) {
          values.splice(idx, 1);
        }
      }
      head += 1;
    }

    // compact the queue occasionally to avoid unbounded growth
    if (head > 32 && head * 2 > queue.length) {
      queue.splice(0, head);
      head = 0;
    }

    queue.push(point);
    if (point.y != null && !Number.isNaN(point.y)) {
      const insertAt = bisectLeft(values, point.y);
      values.splice(insertAt, 0, point.y);
    }

    const hasValues = values.length > 0;
    out.push({
      t: point.t,
      median: hasValues ? percentile(values, 0.5) : null,
      p25: hasValues ? percentile(values, 0.25) : null,
      p75: hasValues ? percentile(values, 0.75) : null,
    });
  }

  return out;
}
