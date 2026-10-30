import { newYorkDate } from './daily-performance.js';

export interface DailyBar {
  source?: 'ibkr' | 'thinkorswim'; adjustment?: string;
  date: string; time: string; open: number; close: number; corporateActions: string[];
}
export interface MarketDay {
  source?: 'ibkr' | 'thinkorswim'; adjustment?: string;
  symbol: string; label: string; date: string; close: number;
  dayChangePct: number | null; sessionChangePct: number; corporateActions: string[];
}

export function dailyBars(input: unknown): DailyBar[] {
  const raw = input as any;
  if (raw?.error || !Array.isArray(raw?.time) || raw.time.length !== raw.open?.length || raw.time.length !== raw.close?.length) throw new Error('日线数据不完整');
  const bars: DailyBar[] = [];
  for (let i = 0; i < raw.time.length; i++) {
    const time = new Date(raw.time[i]), open = raw.open[i], close = raw.close[i];
    if (!Number.isFinite(time.getTime()) || !Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0) continue;
    const date = newYorkDate(time).date;
    const corporateActions = (raw.corp_actions ?? []).filter((a: any) => String(a.date).replaceAll('-', '') === date.replaceAll('-', '')).map((a: any) => String(a.type));
    bars.push({ date, time: time.toISOString(), open, close, corporateActions });
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

export function marketDay(bars: DailyBar[], date: string, symbol: string, label: string): MarketDay | null {
  const i = bars.findIndex(bar => bar.date === date);
  if (i < 0) return null;
  const bar = bars[i], previous = bars[i - 1];
  return { symbol, label, date, close: bar.close, sessionChangePct: (bar.close / bar.open - 1) * 100,
    ...(bar.source ? { source: bar.source, adjustment: bar.adjustment } : {}),
    dayChangePct: previous ? (bar.close / previous.close - 1) * 100 : null, corporateActions: bar.corporateActions };
}
