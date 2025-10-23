export function invariant<T>(val: T, msg = 'Invariant failed'): asserts val {
  if (val === null || val === undefined) throw new Error(msg);
}
export function assertDefined<T>(val: T | null | undefined, msg: string): asserts val is T {
  if (val === null || val === undefined) throw new Error(msg);
}
