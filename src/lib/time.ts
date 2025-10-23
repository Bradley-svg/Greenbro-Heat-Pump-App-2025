export const hourOfWeek = (d: Date | number) => {
  const t = typeof d === 'number' ? new Date(d) : d;
  const dow = (t.getUTCDay() + 6) % 7;
  return dow * 24 + t.getUTCHours();
};
