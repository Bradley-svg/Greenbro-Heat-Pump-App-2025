export type Band = "ok" | "warn" | "crit";

/** High-is-good (e.g., online %). crit if < crit, warn if < warn. */
export function bandHigh(v: number, warn: number, crit: number): Band {
  if (v < crit) return "crit";
  if (v < warn) return "warn";
  return "ok";
}

/** Low-is-good (e.g., latency, freshness minutes). crit if > crit, warn if > warn. */
export function bandLow(v: number, warn: number, crit: number): Band {
  if (v > crit) return "crit";
  if (v > warn) return "warn";
  return "ok";
}
