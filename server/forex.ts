import type { IbkrClient } from './ibkr.js';
import { summarizeForex, fxReference, fxCostReport, type FxSummary, type FxReference } from './forex-calculations.js';

const format = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 });
export function forexReport(value: unknown, year: number, fetchedAt: string): string {
  return formatReport(summarizeForex(value, year), fetchedAt);
}
function formatReport(s: FxSummary, fetchedAt: string): string {
  const lines = [
    s.year + ' 年换汇记录：IB 本年查询返回 ' + s.trades.length + ' 笔货币交易。',
    '范围：YEAR_TO_DATE（UTC 年界）；采集时间：' + fetchedAt + '。',
    '入金/出金流水：当前 MCP 未提供，无法据此统计累计入金本金。以下包含双向换汇和零碎余额转换，不可把所有买入美元重复累计为入金。',
    'CNH↔USD 成交 ' + s.cnhTrades + ' 笔：累计买入 ' + format(s.usdBought) + ' USD，累计卖出 ' + format(s.usdSold) + ' USD；相抵净额 ' + format(s.usdBought - s.usdSold) + ' USD。',
    '对应 CNH 成交支出净额 ' + format(s.cnhSpent - s.cnhReceived) + ' CNH。买入美元加权成交价 ' + (s.buyAverage === null ? '未知' : format(s.buyAverage)) + ' CNH/USD。',
    '上述为换汇成交口径，未核实手续费币种，不能据此认定入金总额。以下时间均为北京时间：',
  ];
  for (const t of s.trades) {
    lines.push(new Date(t.trade_time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '｜' + t.symbol + ' ' + t.side +
      '｜数量 ' + format(t.size) + '｜成交价 ' + format(t.price) + '｜报价币现金变动 ' + format(t.net_amount) + ' ' + t.currency +
      (Number.isFinite(t.commission) && t.commission !== 0 ? '｜手续费 ' + format(t.commission!) + '（币种未提供）' : ''));
  }
  return lines.join('\n');
}

export class ForexHistory {
  private cache?: { year: number; time: number; report: string; summary: FxSummary };
  private pending?: Promise<string>;
  private contractId?: number;
  private reference?: FxReference;
  constructor(private readonly client: Pick<IbkrClient, 'call'>) {}
  async capitalPreview() {
    await this.get();
    if (!this.cache) return null;
    const s = this.cache.summary;
    return { year: s.year, fetchedAt: new Date(this.cache.time).toISOString(),
      usdBought: s.usdBought, usdSold: s.usdSold, netUsd: s.usdBought - s.usdSold,
      cnhSpent: s.cnhSpent, cnhReceived: s.cnhReceived, trades: s.cnhTrades };
  }
  get(): Promise<string> {
    const now = Date.now(), year = new Date(now).getUTCFullYear();
    if (this.cache?.year === year && now - this.cache.time < 300000) return Promise.resolve(this.cache.report);
    if (this.pending) return this.pending;
    this.pending = this.client.call('get_account_trades', { period: 'YEAR_TO_DATE' }).then(raw => {
      const summary = summarizeForex(raw, year);
      const report = formatReport(summary, new Date().toISOString());
      this.cache = { year, time: Date.now(), report, summary };
      return report;
    }).catch(() => this.cache?.year === year ? '最新换汇查询失败，以下为旧缓存：\n' + this.cache.report : '换汇记录读取失败，请检查 IB 授权后重试。入金与出金记录需另行提供账单。')
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async currentRate(): Promise<FxReference | null> {
    if (this.reference && Date.now() - Date.parse(this.reference.fetchedAt) < 30000) return this.reference;
    if (!this.contractId) {
      const result = await this.client.call('search_contracts', { query: 'USD.CNH' }) as any;
      const contracts = result?.results?.filter((item: any) => item.symbol === 'USD' && item.exchange === 'IDEALPRO' &&
        item.sections?.some((section: any) => section.security_type === 'CASH'));
      if (!Array.isArray(contracts) || contracts.length !== 1) throw new Error('USD.CNH 合约无法唯一确认');
      const id = contracts[0].underlying_contract_id;
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('USD.CNH 合约无效');
      this.contractId = id;
    }
    const raw = await this.client.call('get_price_snapshot', { contract_id: this.contractId, market_data_names: ['bid_ask', 'top_status'] });
    const quote = fxReference(raw, this.contractId!, new Date().toISOString());
    if (quote) this.reference = quote;
    return quote;
  }

  async analysis(question = ''): Promise<string> {
    const history = await this.get();
    const cache = this.cache;
    if (!cache || cache.year !== new Date().getUTCFullYear()) return history;
    let reference: FxReference | null = null;
    try { reference = await this.currentRate(); } catch { /* Keep historical costs useful when quotes fail. */ }
    const warning = Date.now() - cache.time >= 300000 ? '换汇记录刷新失败，以下使用历史缓存。\n' : '';
    return warning + fxCostReport(cache.summary, reference, question);
  }
}
