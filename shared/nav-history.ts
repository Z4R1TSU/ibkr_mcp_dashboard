import type { DashboardState } from './types.js';

export const NAV_TIME_ZONE = 'America/New_York';

// Keep observed values, rather than averaging or filling days without a sample.
export function dailyNavHistory(history: DashboardState['history'], timeZone = NAV_TIME_ZONE): DashboardState['history'] {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map<string, DashboardState['history'][number]>();
  for (const point of history) {
    const time = Date.parse(point.time);
    if (!Number.isFinite(time) || !Number.isFinite(point.nav)) continue;
    const date = format.format(new Date(time));
    const previous = days.get(date);
    if (!previous || time >= Date.parse(previous.time)) days.set(date, point);
  }
  return [...days.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-180);
}
