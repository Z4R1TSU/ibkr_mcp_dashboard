import type { PresenceSummary } from '../../shared/discord.js';
import { newYorkDate } from '../daily-performance.js';
import { isUsEquityTradingDate, previousUsEquityTradingDate } from '../us-market-calendar.js';

export function presenceSession(now: Date) {
  const ny = newYorkDate(now);
  const date = new Date(ny.date + 'T00:00:00Z');
  if (ny.hour >= 20) date.setUTCDate(date.getUTCDate() + 1);
  return { date: date.toISOString().slice(0, 10), beforePremarket: ny.hour < 4 || ny.hour >= 20 };
}

export function presenceToday(raw: unknown, currency: string | null, now: Date): NonNullable<PresenceSummary['todayPnl']> {
  const ny = presenceSession(now);
  const value: NonNullable<PresenceSummary['todayPnl']> = { date: ny.date, status: 'pending', amount: null, asOf: null };
  if (!isUsEquityTradingDate(ny.date)) return { ...value, status: 'closed' };
  if (ny.beforePremarket) return { ...value, status: 'before_premarket' };
  const day = (raw as any)?.local_archive?.currentDay;
  if (!day || day.date !== ny.date || day.currency !== currency) return value;
  const asOf = Date.parse(day.asOf);
  if (Number.isFinite(asOf) && asOf <= now.getTime() + 60000) value.asOf = day.asOf;
  if (!Number.isFinite(asOf) || asOf > now.getTime() + 60000 || now.getTime() - asOf >= 600000) {
    return { ...value, status: 'stale' };
  }
  const observed = newYorkDate(new Date(asOf));
  if (observed.date !== ny.date || observed.hour < 4) return value;
  if (![day.startNav, day.endNav, day.returnPct].every(Number.isFinite) || day.startNav <= 0) return value;
  const amount = day.endNav - day.startNav;
  const expected = day.startNav * day.returnPct / 100;
  if (day.previousDate !== previousUsEquityTradingDate(ny.date) || day.flowMismatch
    || Math.abs(amount - expected) > Math.max(0.05, day.startNav * 1e-7)) {
    return { ...value, status: 'flow_mismatch' };
  }
  return { ...value, status: 'ready', amount };
}
