export const z = (value: number, mean?: number | null, std?: number | null) => {
  if (std == null || std === 0) return 0;
  return (value - (mean ?? 0)) / std;
};
