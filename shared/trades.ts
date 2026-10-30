import type { Amount } from './types.js';
import { NAV_TIME_ZONE } from './nav-history.js';

export const TRADE_TIME_ZONE = NAV_TIME_ZONE;
export const TRADE_RANGES = { previous: '上一交易日', today: '今天', '7d': '近 7 天', '30d': '近 30 天', month: '本月', year: '今年' } as const;
export type TradeRange = keyof typeof TRADE_RANGES;
export const isTradeRange = (value: unknown): value is TradeRange => typeof value === 'string' && Object.hasOwn(TRADE_RANGES, value);
export interface Trade {
  id: string; time: string; symbol: string | null; name: string | null;
  assetClass: string | null; side: string | null; size: Amount; price: Amount;
  currency: string | null; netAmount: Amount; commission: Amount;
  orderId: string | null; optionRight: 'P' | 'C' | null;
  optionSource: 'trade' | 'order' | 'user' | null; contractDescription: string | null;
}
export interface TradesState {
  trades: Trade[]; range: TradeRange; startDate: string; endDate: string;
  timeZone: string; fetchedAt: string | null;
  refreshing: boolean; stale: boolean; error: string | null;
}
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TRADE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-US', { timeZone: TRADE_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
export const tradeDate = (time: string | number) => dateFormat.format(new Date(time));
export const tradeClock = (time: string) => clockFormat.format(new Date(time));

export function tradeType(trade: Trade): string {
  const side = trade.side === 'BUY' ? '买入' : trade.side === 'SELL' ? '卖出' : trade.side ?? '方向未知';
  const asset = trade.assetClass === 'STK' ? '正股' : ['OPT', 'FOP'].includes(trade.assetClass ?? '')
    ? trade.optionRight === 'P' ? 'Put' : trade.optionRight === 'C' ? 'Call' : '期权（Put/Call 未提供）'
    : (({ CASH: '外汇', FUT: '期货' } as Record<string, string>)[trade.assetClass ?? ''] ?? trade.assetClass ?? '类型未知');
  return side + ' ' + asset;
}

export function filterTrades(trades: Trade[], now: number, start: string, end: string): Trade[] {
  return trades.filter(t => tradeDate(t.time) >= start && tradeDate(t.time) <= end && Date.parse(t.time) <= now);
}
