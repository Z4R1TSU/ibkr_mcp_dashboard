import { tradeDate, type TradesState } from '../shared/trades.js';
import { cashFlowExchangeRates, cashFlowTotals, type CashFlow, type CashFlowsState } from '../shared/cash-flows.js';
import type { PnlCalendar } from '../shared/pnl-calendar.js';

export function inferCashFlows(history: TradesState): CashFlowsState {
  const records = new Map<string, CashFlow>();
  let skipped = 0;
  for (const trade of history.trades) {
    if (trade.assetClass !== 'CASH') continue;
    const pair = /^([A-Z]{3})\.([A-Z]{3})$/.exec(trade.symbol ?? '');
    if (!pair || !pair.slice(1).includes('USD') || pair[1] === pair[2]) { skipped++; continue; }
    if (trade.currency !== pair[2] || !['BUY', 'SELL'].includes(trade.side ?? '')
      || trade.size === null || trade.price === null || trade.netAmount === null
      || ![trade.size, trade.price, trade.netAmount].every(Number.isFinite)
      || trade.size <= 0 || trade.price <= 0 || !Number.isFinite(Date.parse(trade.time))) { skipped++; continue; }
    const base = trade.side === 'BUY' ? trade.size : -trade.size;
    if (base * trade.netAmount >= 0) { skipped++; continue; }
    const usd = pair[1] === 'USD' ? base : trade.netAmount;
    const counter = pair[1] === 'USD' ? trade.netAmount : base;
    records.set(trade.id, {
      id: trade.id, date: tradeDate(trade.time), time: trade.time,
      direction: usd > 0 ? 'deposit' : 'withdrawal', currency: 'USD', amount: Math.abs(usd),
      counterCurrency: pair[1] === 'USD' ? pair[2] : pair[1], counterAmount: Math.abs(counter),
      symbol: trade.symbol!, side: trade.side as 'BUY' | 'SELL', price: trade.price, commission: trade.commission,
    });
  }
  const rows = [...records.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.id.localeCompare(b.id));
  return { records: rows, totals: cashFlowTotals(rows), exchangeRates: cashFlowExchangeRates(rows), currency: 'USD',
    startDate: history.startDate, endDate: history.endDate, fetchedAt: history.fetchedAt,
    refreshing: history.refreshing, stale: history.stale, error: history.error, skipped };
}

/** FX references never change the original daily P&L, TWR, or trading-day counts. */
export function withCashFlows(calendar: PnlCalendar, flows: CashFlowsState): PnlCalendar {
  const records = flows.records.filter(row => row.date <= calendar.today);
  if (!records.length) return calendar;
  const dates = records.map(row => row.date).sort();
  const monthRecords = records.filter(row => row.date.startsWith(calendar.month + '-'));
  return { ...calendar,
    earliestDate: [calendar.earliestDate, dates[0]].filter((date): date is string => Boolean(date)).sort()[0],
    latestDate: [calendar.latestDate, dates.at(-1)].filter((date): date is string => Boolean(date)).sort().at(-1)!,
    ...(monthRecords.length ? { cashFlows: { ...flows, records: monthRecords, totals: cashFlowTotals(monthRecords),
      exchangeRates: cashFlowExchangeRates(monthRecords) } } : {}),
    days: calendar.days.map(day => {
      const rows = monthRecords.filter(row => row.date === day.date);
      return rows.length ? { ...day, cashFlows: rows } : day;
    }),
  };
}
