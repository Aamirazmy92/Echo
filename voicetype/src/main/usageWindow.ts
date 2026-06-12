// Week window used by the Basic-tier weekly word cap. The week starts
// Monday 00:00 local time; entries store created_at as UTC ISO strings,
// so the gate compares ISO strings (lexicographic order == time order).

export function getStartOfWeek(date: Date): Date {
  const start = new Date(date);
  const day = start.getDay();
  const daysSinceMonday = (day + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  start.setHours(0, 0, 0, 0);
  return start;
}

export function getWeekStartIso(now: Date = new Date()): string {
  return getStartOfWeek(now).toISOString();
}
