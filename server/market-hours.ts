import { config } from './config.js';
import { newYorkDate } from './daily-performance.js';
import { isUsEquityTradingDate } from './us-market-calendar.js';

// US extended hours; the same window as the PA "today" read and the presence session.
const OPEN_HOUR = 4, CLOSE_HOUR = 20;

export function marketActive(at: number): boolean {
  const ny = newYorkDate(new Date(at));
  return isUsEquityTradingDate(ny.date) && ny.hour >= OPEN_HOUR && ny.hour < CLOSE_HOUR;
}

export function nextMarketOpen(at: number): number {
  const ny = newYorkDate(new Date(at));
  const cursor = new Date(ny.date + 'T00:00:00Z');
  if (ny.hour >= OPEN_HOUR) cursor.setUTCDate(cursor.getUTCDate() + 1);
  for (let i = 0; i < 370 && !isUsEquityTradingDate(cursor.toISOString().slice(0, 10)); i++) cursor.setUTCDate(cursor.getUTCDate() + 1);
  // New York 04:00 is 08:00 UTC in daylight time and 09:00 UTC in standard
  // time. Clocks change on Sundays, so a trading day's 04:00 is unambiguous.
  for (const hour of [8, 9]) {
    const candidate = cursor.getTime() + hour * 3600000;
    if (newYorkDate(new Date(candidate)).hour === OPEN_HOUR) return candidate;
  }
  throw new Error('New York session start unavailable');
}

/**
 * When a background IB read made at `from` is next due. Each read after the
 * ten-minute access token has expired rotates the refresh token, and every
 * rotation is a chance to lose it. Closed markets therefore use wall-clock
 * slots that all background readers share, so a slot costs one rotation.
 */
export function nextBackgroundRead(from: number, activeMs: number, closedMs = config.closedPollSeconds * 1000): number {
  if (marketActive(from)) return from + activeMs;
  return Math.min((Math.floor(from / closedMs) + 1) * closedMs, nextMarketOpen(from));
}

/** How long data read at `at` stays current: while closed, until the next scheduled read. */
export function freshFor(at: number, staleMs: number): number {
  return marketActive(at) ? staleMs : nextBackgroundRead(at, 0) - at + staleMs;
}
