import { completedDay, dailyPerformance } from '../daily-performance.js';
import type { PresenceSummary } from '../../shared/discord.js';
import { validDate } from './settings.js';

const iso = (value: unknown): string => typeof value === 'string' && /^\d{8}$/.test(value)
  ? value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6) : String(value);

export function latestPerformanceTradingDate(input: unknown, marketDate: string | null, now = new Date()): string | null {
  const data = input as any;
  const ceiling = marketDate && completedDay(marketDate, now) ? marketDate : null;
  const dates = new Set<string>();
  for (const account of Object.values(data?.accounts ?? {}) as any[]) {
    for (const period of Object.values(account.periods ?? {}) as any[]) {
      if (period.frequency !== 'D' || !Array.isArray(period.dates)) continue;
      for (const value of period.dates) {
        const date = iso(value);
        if (completedDay(date, now) && (!ceiling || date <= ceiling)) dates.add(date);
      }
    }
  }
  return [...dates].sort().at(-1) ?? ceiling;
}

export function presencePerformance(input: unknown, date: string, startDate: string, includeTotal = true) {
  const warnings: string[] = [];
  const value: NonNullable<PresenceSummary['performance']> = { date, since: null, totalReturnPct: null, dailyReturnPct: null };
  const data = input as any;
  const accounts = Object.values(data?.accounts ?? {}) as any[];
  if (accounts.length !== 1 || data?.portfolio_measure !== 'TWR') {
    return { value, currency: null, warnings: ['账户范围或 TWR 口径无法确认，收益率暂缺'] };
  }
  const currency = typeof accounts[0].base_currency === 'string' ? accounts[0].base_currency : null;
  try { value.dailyReturnPct = dailyPerformance(data, date).returnPct; }
  catch { warnings.push(date + ' 的日收益尚未返回'); }
  if (!includeTotal) return { value, currency, warnings };
  const periods = Object.values(accounts[0].periods ?? {}) as any[];
  if (!validDate(startDate)) return { value, currency, warnings };
  // Cumulative return must cover the requested starting date; never substitute YTD.
  for (const period of periods) {
    if (!Array.isArray(period.dates) || !Array.isArray(period.cps) || period.dates.length !== period.cps.length) continue;
    const dates = period.dates.map(iso) as string[];
    if (!dates.length || dates.some((d, i) => !validDate(d) || (i > 0 && d <= dates[i - 1]))) continue;
    const origin = iso(period.start_date);
    if (!validDate(origin) || origin > startDate || origin > dates[0]) continue;
    const end = dates.indexOf(date);
    if (end < 0) continue;
    let beforeIndex = -1;
    for (let i = 0; i < dates.length && dates[i] < startDate; i++) beforeIndex = i;
    let before: number;
    // IB start_date is the preceding valuation day for its first daily point.
    if (origin === startDate || (period.frequency === 'D' && dates[0] === startDate)) before = 0;
    else if (period.frequency === 'D' && beforeIndex >= 0) before = period.cps[beforeIndex];
    else continue;
    const after = period.cps[end];
    if (!Number.isFinite(before) || before <= -1 || !Number.isFinite(after) || after < -1 || date < startDate) continue;
    const cumulative = ((1 + after) / (1 + before) - 1) * 100;
    if (!Number.isFinite(cumulative)) continue;
    value.totalReturnPct = cumulative;
    value.since = startDate;
    break;
  }
  if (value.totalReturnPct === null) warnings.push('IB 暂未提供覆盖 ' + startDate + ' 至 ' + date + ' 的完整 TWR 数据，累计收益暂缺');
  return { value, currency, warnings };
}
