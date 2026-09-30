import type { IbkrClient } from './ibkr.js';
import { PerformanceSource } from './performance-source.js';
import type { DashboardState } from '../shared/types.js';
import { completedDay, dailyPerformance, newYorkDate, type DailyPerformance } from './daily-performance.js';
import { dailyBars, marketDay, type DailyBar, type MarketDay } from './daily-market.js';

export interface DailyFacts {
  date: string; generatedAt: string; account: DailyPerformance;
  benchmarks: MarketDay[]; holdings: MarketDay[]; warnings: string[];
}

export class DailyData {
  private contracts = new Map<string, { id: number; exchange: string }>();
  private prices = new Map<number, { at: number; bars: DailyBar[] }>();
  constructor(private readonly client: Pick<IbkrClient, 'call'>, private readonly performance = new PerformanceSource(client)) {}
  private async stock(symbol: string) {
    const known = this.contracts.get(symbol);
    if (known) return known;
    const data = await this.client.call('search_contracts', { query: symbol }) as any;
    const matches = data?.results?.filter((row: any) => row.symbol === symbol && row.country_code === 'US' && row.sections?.some((s: any) => s.security_type === 'STK'));
    if (!Array.isArray(matches) || matches.length !== 1 || !Number.isSafeInteger(matches[0].underlying_contract_id)) throw new Error('合约匹配不唯一');
    const value = { id: matches[0].underlying_contract_id, exchange: matches[0].exchange || 'SMART' };
    this.contracts.set(symbol, value);
    return value;
  }
  private async bars(id: number, exchange = 'SMART'): Promise<DailyBar[]> {
    const known = this.prices.get(id);
    if (known && Date.now() - known.at < 300000) return known.bars;
    const raw = await this.client.call('get_price_history', { contract_id: id, exchange, security_type: 'STK', period: 'ONE_MONTH', step: 'ONE_DAY', outside_rth: false, include_corporate_actions: true });
    const bars = dailyBars(raw);
    this.prices.set(id, { at: Date.now(), bars });
    return bars;
  }
  async latestCompletedDate(now = new Date()): Promise<string> {
    const spy = await this.stock('SPY');
    const spyBars = await this.bars(spy.id, spy.exchange);
    const date = spyBars.filter(bar => completedDay(bar.date, now)).at(-1)?.date;
    if (!date) throw new Error('上一美股交易日行情尚未返回');
    return date;
  }
  async previousTradingDate(now = new Date()): Promise<string> {
    const spy = await this.stock('SPY');
    const bars = await this.bars(spy.id, spy.exchange);
    const date = bars.filter(bar => bar.date < newYorkDate(now).date).at(-1)?.date;
    if (!date) throw new Error('上一交易日日期不可用');
    return date;
  }
  async get(state: DashboardState, now = new Date()): Promise<DailyFacts> {
    const date = await this.latestCompletedDate(now);
    const performance = await this.performance.get();
    const account = dailyPerformance(performance, date);
    const facts: DailyFacts = { date, account, generatedAt: now.toISOString(), benchmarks: [], holdings: [], warnings: [] };
    const labels = [['SPY', '标普500 ETF'], ['QQQ', '纳斯达克100 ETF'], ['DIA', '道琼斯 ETF'], ['IWM', '罗素2000 ETF']];
    for (const [symbol, label] of labels) {
      try {
        const contract = await this.stock(symbol);
        const row = marketDay(await this.bars(contract.id, contract.exchange), date, symbol, label);
        if (!row) throw new Error('Missing day');
        facts.benchmarks.push(row);
      } catch { facts.warnings.push(symbol + ' 的该交易日日线缺失'); }
    }
    const held = [...(state.snapshot?.positions ?? [])].filter(p => p.kind === 'stock' && p.currency === 'USD')
      .sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0)).slice(0, 5);
    for (const position of held) {
      try {
        const row = marketDay(await this.bars(position.id), date, position.symbol, position.symbol);
        if (!row) throw new Error('Missing day');
        const existing = facts.holdings.find(item => item.symbol === row.symbol);
        if (!existing) facts.holdings.push(row);
      } catch { facts.warnings.push(position.symbol + ' 的该交易日日线缺失'); }
    }
    return facts;
  }
}
