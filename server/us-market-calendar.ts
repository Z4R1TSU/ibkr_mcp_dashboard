const calendars = new Map<number, Set<string>>();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const day = (year: number, month: number, date: number) => new Date(Date.UTC(year, month - 1, date));
const nthMonday = (year: number, month: number, n: number) => 1 + (8 - day(year, month, 1).getUTCDay()) % 7 + (n - 1) * 7;

function holidays(year: number): Set<string> {
  const cached = calendars.get(year);
  if (cached) return cached;
  const closed = new Set<string>();
  const observed = (month: number, date: number, observeSaturday = true) => {
    const value = day(year, month, date), weekday = value.getUTCDay();
    value.setUTCDate(value.getUTCDate() + (weekday === 0 ? 1 : weekday === 6 && observeSaturday ? -1 : 0));
    closed.add(iso(value));
  };
  // NYSE does not close the preceding Friday when New Year's Day is a Saturday.
  observed(1, 1, false);
  if (year >= 1998) closed.add(iso(day(year, 1, nthMonday(year, 1, 3))));
  closed.add(iso(day(year, 2, nthMonday(year, 2, 3))));
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - c % 4) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easter = h + l - 7 * m + 114;
  closed.add(iso(day(year, Math.floor(easter / 31), easter % 31 - 1)));
  const memorial = day(year, 5, 31);
  memorial.setUTCDate(31 - (memorial.getUTCDay() + 6) % 7);
  closed.add(iso(memorial));
  if (year >= 2022) observed(6, 19);
  observed(7, 4);
  closed.add(iso(day(year, 9, nthMonday(year, 9, 1))));
  closed.add(iso(day(year, 11, 1 + (11 - day(year, 11, 1).getUTCDay()) % 7 + 21)));
  observed(12, 25);
  calendars.set(year, closed);
  return closed;
}

const exceptionalClosures = new Set(['2001-09-11', '2001-09-12', '2001-09-13', '2001-09-14',
  '2004-06-11', '2007-01-02', '2012-10-29', '2012-10-30', '2018-12-05', '2025-01-09']);

/** Regular US equity sessions; observed SPY sessions remain the date-selection ceiling. */
export function isUsEquityTradingDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || iso(date) !== value) return false;
  const weekday = date.getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays(date.getUTCFullYear()).has(value) && !exceptionalClosures.has(value);
}

export function previousUsEquityTradingDate(value: string): string {
  const cursor = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(cursor.getTime()) || iso(cursor) !== value) throw new Error('Invalid trading date');
  for (let i = 0; i < 370; i++) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const candidate = iso(cursor);
    if (isUsEquityTradingDate(candidate)) return candidate;
  }
  throw new Error('Previous trading date unavailable');
}

/** Scheduled NYSE early closes for modern US equity research. */
export function usEquityCloseHour(value: string): number {
  const date = new Date(value + 'T00:00:00Z');
  if (!isUsEquityTradingDate(value)) return 16;
  const month = date.getUTCMonth() + 1, d = date.getUTCDate(), week = date.getUTCDay();
  if (month === 11 && week === 5 && d >= 23 && d <= 29) return 13;
  if (month === 12 && d === 24 || month === 7 && d === 3) return 13;
  return 16;
}
