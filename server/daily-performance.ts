export interface DailyPerformance {
  date: string; previousDate: string; currency: string;
  startNav: number; endNav: number; navChange: number; returnPct: number | null;
  flowMismatch: boolean; measure: string;
}

export function newYorkDate(now: Date): { date: string; hour: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  return { date: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour) };
}
export function completedDay(date: string, now: Date): boolean {
  const ny = newYorkDate(now);
  return date < ny.date || (date === ny.date && ny.hour >= 16);
}
const isoDate = (s: string) => /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s;

export function dailyPerformance(input: unknown, date: string): DailyPerformance {
  const data = input as any;
  const accounts = Object.values(data?.accounts ?? {}) as any[];
  if (accounts.length !== 1) throw new Error('日度账户范围不明确');
  const account = accounts[0];
  for (const name of ['LOCAL', '1D', '7D', 'MTD', '1M', 'YTD', '1Y']) {
    const p = account.periods?.[name];
    if (!p || p.frequency !== 'D' || !Array.isArray(p.dates) || p.dates.length !== p.nav?.length || p.dates.length !== p.cps?.length) continue;
    const i = p.dates.findIndex((d: string) => isoDate(d) === date);
    if (i < 0) continue;
    const startNav = i ? p.nav[i - 1] : p.start_nav, endNav = p.nav[i];
    if (!Number.isFinite(startNav) || startNav <= 0 || !Number.isFinite(endNav)) continue;
    const before = i ? p.cps[i - 1] : 0, after = p.cps[i];
    const rate = data.portfolio_measure === 'TWR' && Number.isFinite(before) && Number.isFinite(after) && before > -1 ? (1 + after) / (1 + before) - 1 : null;
    const change = endNav - startNav;
    return { date, previousDate: isoDate(i ? p.dates[i - 1] : p.start_date), currency: account.base_currency,
      startNav, endNav, navChange: change, returnPct: rate === null ? null : rate * 100,
      flowMismatch: rate === null || Math.abs(change - startNav * rate) > Math.max(0.05, Math.abs(startNav) * 1e-7),
      measure: String(data.portfolio_measure) };
  }
  throw new Error('目标交易日的账户净值尚未更新');
}
