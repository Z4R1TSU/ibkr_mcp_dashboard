import { normalizeQuote } from './normalize.js';

export interface FxTrade {
  trade_id: string; symbol: string; side: 'BUY' | 'SELL'; size: number; price: number;
  currency: string; net_amount: number; commission?: number; trade_time: string;
}
export interface FxSummary {
  year: number; trades: FxTrade[]; cnhTrades: number;
  usdBought: number; usdSold: number; cnhSpent: number; cnhReceived: number;
  buyAverage: number | null;
}

export interface FxReference {
  rate: number; bid: number; ask: number; fetchedAt: string; status: 'REALTIME' | 'DELAYED';
}

export function fxReference(raw: unknown, contractId: number, fetchedAt: string): FxReference | null {
  const quote = normalizeQuote(contractId, raw, fetchedAt);
  if (quote.status !== 'REALTIME' && quote.status !== 'DELAYED') return null;
  if (quote.bid === null || quote.ask === null || quote.bid <= 0 || quote.ask < quote.bid) return null;
  return { rate: (quote.bid + quote.ask) / 2, bid: quote.bid, ask: quote.ask, fetchedAt, status: quote.status };
}

export function fxReturnPercent(cost: number, rate: number): number {
  if (!Number.isFinite(cost) || !Number.isFinite(rate) || cost <= 0 || rate <= 0) throw new Error('汇率必须为有效正数');
  return (rate / cost - 1) * 100;
}

export function fxCostReport(summary: FxSummary, reference: FxReference | null, question = ''): string {
  const cost = summary.buyAverage;
  if (cost === null) return '本年记录中没有可计算的 CNH 买入 USD 交易，平均成本未知。';
  const lines = [summary.year + ' 年 CNH 买入 USD 的加权平均成本：' + cost.toFixed(4) + ' CNH/USD（手续费币种尚未核实）。'];
  const match = /(\d+(?:\.\d+)?)\s*(?:以上|以下)/.exec(question) ?? /(?:高于|低于|超过)\s*(\d+(?:\.\d+)?)/.exec(question);
  const threshold = match ? Number(match[1]) : null;
  if (threshold !== null && threshold > 0) lines.push('平均成本' + (cost > threshold ? '高于 ' : cost < threshold ? '低于 ' : '等于 ') + threshold + '。');
  if (reference) {
    const change = fxReturnPercent(cost, reference.rate);
    lines.push('IB USD.CNH 买卖中间价：' + reference.rate.toFixed(5) + ' CNH/USD，' + (reference.status === 'REALTIME' ? '实时源' : '延迟源') + '；采样时间 ' + reference.fetchedAt + '。');
    lines.push('以 CNH 计价，纯汇率变化率 =（当前汇率 ÷ 历史买入成本 − 1）× 100% = ' + change.toFixed(2) + '%，相当于' + (change < 0 ? '亏 ' : '赚 ') + Math.abs(change).toFixed(2) + '%。');
  } else {
    lines.push('当前没有取得可用的 USD.CNH 买卖报价，无法计算当前汇率变化率；不会用旧成交汇率代替。');
  }
  lines.push('口径是今年所有 CNH→USD 买入的加权价；反向换汇单独记录，不等于当前全部美元资产的成本。');
  lines.push('中间价仅作参考；以上不含投资收益、利息和未确认的费用，也不是账户总收益率。');
  return lines.join('\n');
}

export function summarizeForex(value: unknown, year: number): FxSummary {
  const raw = value as { trades?: unknown };
  if (!Array.isArray(raw?.trades)) throw new Error('IB 未返回交易列表');
  const seen = new Set<string>(), trades: FxTrade[] = [];
  for (const item of raw.trades) {
    if (typeof item?.trade_id !== 'string') throw new Error('交易缺少唯一 ID');
    if (seen.has(item.trade_id)) continue;
    seen.add(item.trade_id);
    if (item.sec_type !== 'CASH') continue;
    const date = new Date(item.trade_time);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== year) throw new Error('换汇时间不在请求年度内');
    if (typeof item.symbol !== 'string' || !/^[A-Z]{3}\.[A-Z]{3}$/.test(item.symbol) || item.currency !== item.symbol.split('.')[1]) throw new Error('换汇币种无效');
    if (!['BUY', 'SELL'].includes(item.side) || ![item.size, item.price, item.net_amount].every(Number.isFinite) || item.size <= 0 || item.price <= 0) throw new Error('换汇数量或价格无效');
    const base = item.side === 'BUY' ? item.size : -item.size;
    if (base * item.net_amount >= 0) throw new Error('换汇方向不一致');
    trades.push(item);
  }
  trades.sort((a, b) => a.trade_time.localeCompare(b.trade_time));
  const result: FxSummary = { year, trades, cnhTrades: 0, usdBought: 0, usdSold: 0, cnhSpent: 0, cnhReceived: 0, buyAverage: null };
  for (const trade of trades) {
    if (!['USD.CNH', 'CNH.USD'].includes(trade.symbol)) continue;
    const base = trade.side === 'BUY' ? trade.size : -trade.size;
    const usd = trade.symbol === 'USD.CNH' ? base : trade.net_amount;
    const cnh = trade.symbol === 'CNH.USD' ? base : trade.net_amount;
    result.usdBought += Math.max(0, usd); result.usdSold += Math.max(0, -usd);
    result.cnhSpent += Math.max(0, -cnh); result.cnhReceived += Math.max(0, cnh);
    result.cnhTrades++;
  }
  result.buyAverage = result.usdBought > 0 ? result.cnhSpent / result.usdBought : null;
  return result;
}
