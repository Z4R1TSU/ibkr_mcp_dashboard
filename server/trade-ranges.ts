import { tradeDate, type TradeRange } from '../shared/trades.js';
import { previousUsEquityTradingDate } from './us-market-calendar.js';

export function tradeWindow(range: TradeRange, now: number) {
  const today = tradeDate(now), year = today.slice(0, 4);
  let startDate = today, endDate = today;
  if (range === 'previous') startDate = endDate = previousUsEquityTradingDate(today);
  else if (range === '7d' || range === '30d') {
    startDate = new Date(Date.parse(today) - (range === '7d' ? 6 : 29) * 86400000).toISOString().slice(0, 10);
  } else if (range === 'month') startDate = today.slice(0, 7) + '-01';
  else if (range === 'year') startDate = year + '-01-01';
  const periods = range !== 'year' ? ['DAYS_60'] : new Date(now).getUTCFullYear().toString() === year
    ? ['YEAR_TO_DATE'] : ['FOUR_QUARTERS_AGO', 'THREE_QUARTERS_AGO', 'TWO_QUARTERS_AGO', 'LAST_QUARTER', 'YEAR_TO_DATE'];
  return { range, startDate, endDate, periods, key: range === 'year' ? 'year:' + year : 'recent' };
}
