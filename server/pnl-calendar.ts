import { calendarDates, PNL_TIME_ZONE, type PnlCalendar, type PnlCalendarDay } from '../shared/pnl-calendar.js';
import { newYorkDate, type DailyPerformance } from './daily-performance.js';
import type { PerformanceDay } from './performance-store.js';
import { isUsEquityTradingDate, previousUsEquityTradingDate } from './us-market-calendar.js';

/** Read every archived day, including records before a gap in the TWR chain. */
export function buildPnlCalendar(month: string, currency: string | null, records: PerformanceDay[],
  current: (DailyPerformance & { asOf: string }) | undefined, now = new Date()): PnlCalendar {
  const ny = newYorkDate(now);
  const rows = new Map(records.filter(day => day.date <= ny.date && isUsEquityTradingDate(day.date)).map(day => [day.date, day]));
  // A carried-over observation must never be presented as today's value.
  if (current?.date === ny.date && current.currency === currency && current.measure === 'TWR'
    && isUsEquityTradingDate(current.date) && Number.isFinite(Date.parse(current.asOf))
    && Date.parse(current.asOf) <= now.getTime() + 60000 && newYorkDate(new Date(current.asOf)).date === ny.date
    && newYorkDate(new Date(current.asOf)).hour >= 4
    && [current.startNav, current.endNav, current.returnPct].every(Number.isFinite)) {
    const previous = rows.get(current.date);
    if (!previous || previous.source === 'ib-pa' && Date.parse(current.asOf) >= Date.parse(previous.fetchedAt)) {
      rows.set(current.date, { ...current, returnPct: current.returnPct!, fetchedAt: current.asOf, source: 'ib-pa', provisional: true });
    }
  }
  const days = calendarDates(month).map((date): PnlCalendarDay => {
    const base: PnlCalendarDay = { date, status: date > ny.date ? 'future' : isUsEquityTradingDate(date) ? 'missing' : 'closed',
      pnl: null, returnPct: null, startNav: null, endNav: null, navChange: null,
      previousDate: null, issue: null, provisional: false, asOf: null, source: null };
    if (base.status !== 'missing') return base;
    const row = rows.get(date);
    if (!row || ![row.startNav, row.endNav, row.returnPct].every(Number.isFinite) || row.startNav <= 0) return base;
    const navChange = row.endNav - row.startNav;
    const gap = row.previousDate !== previousUsEquityTradingDate(date);
    const flow = Math.abs(navChange - row.startNav * row.returnPct / 100) > Math.max(0.05, row.startNav * 1e-7);
    return { ...base, status: 'available', startNav: row.startNav, endNav: row.endNav, navChange,
      previousDate: row.previousDate, pnl: gap || flow ? null : Math.round(navChange * 100) / 100,
      returnPct: gap ? null : Math.abs(row.returnPct) < 1e-10 ? 0 : row.returnPct,
      issue: gap ? 'date-gap' : flow ? 'cash-flow' : null,
      provisional: row.source === 'ib-pa' ? date === ny.date || Boolean(row.provisional) : Boolean(row.provisional),
      source: row.source,
      asOf: Number.isFinite(Date.parse(row.fetchedAt)) ? row.fetchedAt : null };
  });
  const expected = days.filter(day => day.status === 'available' || day.status === 'missing');
  const recorded = expected.filter(day => day.returnPct !== null);
  const amounts = expected.filter(day => day.pnl !== null);
  const throughDate = expected.filter(day => day.status === 'available').at(-1)?.date ?? null;
  const mtd = throughDate ? expected.filter(day => day.date <= throughDate) : [];
  const completeMtd = mtd.length > 0 && mtd.every(day => day.returnPct !== null);
  const dates = [...rows.keys()].sort();
  const timestamps = days.flatMap(day => day.asOf ? [day.asOf] : []).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { month, today: ny.date, timeZone: PNL_TIME_ZONE, currency,
    earliestDate: dates[0] ?? null, latestDate: dates.at(-1) ?? null, updatedAt: timestamps.at(-1) ?? null,
    refreshing: false, offline: false, days, summary: {
      pnl: amounts.length ? Math.round(amounts.reduce((sum, day) => sum + day.pnl!, 0) * 100) / 100 : null,
      returnPct: completeMtd
        ? (mtd.reduce((factor, day) => factor * (1 + day.returnPct! / 100), 1) - 1) * 100 : null,
      returnThroughDate: completeMtd ? throughDate : null,
      amountDays: amounts.length, recordedDays: recorded.length, expectedDays: expected.length,
      profitDays: recorded.filter(day => day.returnPct! > 0).length,
      lossDays: recorded.filter(day => day.returnPct! < 0).length,
      flatDays: recorded.filter(day => day.returnPct === 0).length,
      provisional: recorded.some(day => day.provisional),
    } };
}
