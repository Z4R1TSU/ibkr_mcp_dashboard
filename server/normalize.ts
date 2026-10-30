import type { Account, Amount, Analysis, OptionContract, OptionRisk, Position, Quote, Snapshot } from '../shared/types.js';

type Data = Record<string, unknown>;
function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('IB 响应结构发生变化');
  return value as Data;
}
export function numeric(value: unknown): Amount {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}
function sum(values: Amount[]): Amount {
  return values.some(value => value === null) ? null : values.reduce<number>((total, value) => total + value!, 0);
}
export function ratio(numerator: Amount, denominator: Amount): Amount {
  return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null;
}
export function parseOption(description: string): OptionContract | null {
  const match = description.match(/\[([A-Z0-9.]+)\s+(\d{6})([CP])(\d{8})\s+(\d+(?:\.\d+)?)\]$/);
  if (!match) return null;
  const expiry = `20${match[2].slice(0, 2)}-${match[2].slice(2, 4)}-${match[2].slice(4, 6)}`;
  const date = new Date(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== expiry || Number(match[5]) <= 0) return null;
  return { underlying: match[1], expiry, right: match[3] as 'C' | 'P', strike: Number(match[4]) / 1000, multiplier: Number(match[5]) };
}
export function analyze(positions: Position[], account: Account): Analysis {
  const warnings: string[] = [];
  const allBaseCurrency = positions.every(position => position.currency === account.currency && account.currency !== 'UNKNOWN');
  const aggregate = (selected: Position[], field: 'value' | 'unrealizedPnl') => allBaseCurrency ? sum(selected.map(position => position[field])) : null;
  const stocks = positions.filter(position => position.kind === 'stock');
  const options = positions.filter(position => position.kind === 'option');
  const netPositionValue = aggregate(positions, 'value');
  const sharesAvailable = new Map<string, number | null>();
  for (const position of stocks) {
    const key = `${position.symbol}|${position.currency}`;
    const existing = sharesAvailable.get(key);
    sharesAvailable.set(key, position.quantity === null || existing === null ? null : (existing ?? 0) + position.quantity);
  }
  const optionRisks: OptionRisk[] = [];
  for (const position of [...options].sort((first, second) => (first.option?.expiry ?? '').localeCompare(second.option?.expiry ?? '') || first.id - second.id)) {
    const option = position.option;
    if (!option || position.quantity === null || position.quantity >= 0) continue;
    const contracts = Math.abs(position.quantity);
    const shares = contracts * option.multiplier;
    const key = `${option.underlying}|${position.currency}`;
    const available = sharesAvailable.get(key);
    const capacity = available === null ? null : Math.max(0, available ?? 0);
    const matchedShares = option.right === 'C' && capacity !== null ? Math.min(capacity, shares) : null;
    if (matchedShares !== null && capacity !== null) sharesAvailable.set(key, capacity - matchedShares);
    optionRisks.push({ id: position.id, underlying: option.underlying, currency: position.currency, expiry: option.expiry, right: option.right, strike: option.strike, multiplier: option.multiplier, contracts, shares, strikeNotional: shares * option.strike, matchedShares, unmatchedShares: matchedShares !== null ? shares - matchedShares : null });
  }
  const shortPutNotional = allBaseCurrency && !positions.some(position => position.kind === 'other') && options.every(position => position.quantity !== null && (position.quantity >= 0 || position.option !== null))
    ? sum(optionRisks.filter(option => option.right === 'P').map(option => option.strikeNotional)) : null;
  const residual = account.nav !== null && account.cash !== null && netPositionValue !== null ? account.nav - account.cash - netPositionValue : null;
  if (!allBaseCurrency) warnings.push('存在非基准币种持仓；未验证汇率口径，跨币种合计与集中度暂停计算。');
  if (positions.some(position => position.value === null || position.quantity === null || position.unrealizedPnl === null)) warnings.push('部分持仓字段缺失；相关合计显示为 —，没有按零补齐。');
  if (positions.some(position => position.kind === 'other' || (position.kind === 'option' && !position.option))) warnings.push('存在未识别的合约；期权风险分析可能不完整。');
  if (residual !== null && Math.abs(residual) > 0.02) warnings.push('IB 净值与现金加持仓市值存在差额；可能包含应计项目或非同步快照，未强行配平。');
  warnings.push('账户、持仓和余额为分次查询；持仓接口没有提供行情源时间。独立报价不覆盖 IB 持仓估值。');
  if (optionRisks.length) warnings.push('期权条款由 IB 合约描述解析；股票数量匹配不代表券商确认的备兑，调整合约须核实交割条款。卖 Put 行权金额不是当前亏损或保证金，也未抵扣权利金或组合保护。');
  const largest = stocks.filter(position => position.value !== null && position.value > 0).sort((first, second) => second.value! - first.value!).slice(0, 3);
  return {
    allBaseCurrency,
    grossAbsoluteValue: allBaseCurrency ? sum(positions.map(position => position.value === null ? null : Math.abs(position.value))) : null,
    netPositionValue,
    stockValue: aggregate(stocks, 'value'), optionValue: aggregate(options, 'value'),
    stockPnl: aggregate(stocks, 'unrealizedPnl'), optionPnl: aggregate(options, 'unrealizedPnl'), totalPositionPnl: aggregate(positions, 'unrealizedPnl'),
    topThreeWeight: allBaseCurrency && stocks.every(position => position.value !== null) ? ratio(sum(largest.map(position => position.value)), account.nav) : null,
    cashRatio: ratio(account.cash, account.nav), marginBufferRatio: ratio(account.excessLiquidity, account.equityWithLoan),
    shortPutNotional, shortPutCashGap: shortPutNotional !== null && account.cash !== null ? Math.max(0, shortPutNotional - Math.max(0, account.cash)) : null,
    residual, options: optionRisks, warnings,
  };
}
export function normalizeSnapshot(rawPositions: unknown, rawSummary: unknown, rawBalances: unknown, sources: Snapshot['sources']): Snapshot {
  const positionData = object(rawPositions);
  const summary = object(rawSummary);
  const balanceData = object(rawBalances);
  if (!Array.isArray(positionData.positions) || !Array.isArray(balanceData.balances)) throw new Error('IB 持仓或余额结构发生变化');
  const currency = typeof summary.currency === 'string' ? summary.currency : 'UNKNOWN';
  const balanceRows = balanceData.balances.map(object);
  const base = balanceRows.find(balance => balance.currency === 'BASE');
  const nonBase = balanceRows.filter(balance => balance.currency !== 'BASE');
  const aggregateBalance = base ?? (nonBase.length === 1 && nonBase[0].currency === currency ? nonBase[0] : undefined);
  const account: Account = {
    currency, nav: numeric(summary.net_liquidation), cash: numeric(summary.total_cash_value), buyingPower: numeric(summary.buying_power),
    availableFunds: numeric(summary.available_funds), equityWithLoan: numeric(summary.equity_with_loan_value), initialMargin: numeric(summary.initial_margin),
    maintenanceMargin: numeric(summary.maintenance_margin), excessLiquidity: numeric(summary.excess_liquidity), grossPositionValue: numeric(summary.gross_position_value),
    dividends: numeric(summary.dividends), leverage: typeof summary.leverage === 'string' && summary.leverage.trim() ? numeric(Number(summary.leverage)) : numeric(summary.leverage),
    unrealizedPnl: numeric(aggregateBalance?.unrealized_pnl), realizedPnl: numeric(aggregateBalance?.realized_pnl),
  };
  if (account.nav === null) throw new Error('IB 未返回账户净值，保留上次快照');
  const seen = new Set<number>();
  const positions: Position[] = positionData.positions.map((row: unknown) => {
    const value = object(row);
    const id = numeric(value.contract_id);
    if (id === null || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) throw new Error('IB 合约 ID 缺失或重复');
    seen.add(id);
    const description = typeof value.contract_description === 'string' ? value.contract_description : `合约 ${id}`;
    const brokerAssetClass = typeof value.asset_class === 'string' ? value.asset_class : null;
    const option = parseOption(description);
    const kind = brokerAssetClass === 'OPT' || (!brokerAssetClass && option) ? 'option' : brokerAssetClass === 'STK' ? 'stock' : 'other';
    const positionCurrency = typeof value.currency === 'string' ? value.currency : 'UNKNOWN';
    const marketValue = numeric(value.market_value);
    return { id, description, symbol: kind === 'option' && option ? option.underlying : description, brokerAssetClass, kind, option: kind === 'option' ? option : null, currency: positionCurrency,
      quantity: numeric(value.position), price: numeric(value.market_price), value: marketValue, averagePrice: numeric(value.average_price), unrealizedPnl: numeric(value.unrealized_pnl),
      navWeight: positionCurrency === currency && currency !== 'UNKNOWN' ? ratio(marketValue, account.nav) : null };
  });
  return { version: 1, fetchedAt: sources.balances, sources, account, positions,
    balances: nonBase.map(balance => ({ currency: typeof balance.currency === 'string' ? balance.currency : 'UNKNOWN', cash: numeric(balance.cash_balance), settledCash: numeric(balance.settled_cash), unrealizedPnl: numeric(balance.unrealized_pnl) })),
    analysis: analyze(positions, account) };
}
export function normalizeQuote(id: number, raw: unknown, fetchedAt: string): Quote {
  const value = object(raw);
  const last = value.last && typeof value.last === 'object' ? object(value.last) : {};
  const bidAsk = value['bid-ask'] && typeof value['bid-ask'] === 'object' ? object(value['bid-ask']) : {};
  const top = value['top-status'] && typeof value['top-status'] === 'object' ? object(value['top-status']) : {};
  const mark = value.plprice && typeof value.plprice === 'object' ? object(value.plprice) : {};
  const timestamp = numeric(last.ts);
  const milliseconds = timestamp !== null ? timestamp * 1000 : null;
  const lastTradeAt = milliseconds !== null && milliseconds > 0 && milliseconds < 8640000000000000 ? new Date(milliseconds).toISOString() : null;
  return { id, source: 'ibkr', fetchedAt, last: numeric(last.price), lastTradeAt, lastIsClose: typeof last.is_close === 'boolean' ? last.is_close : null,
    mark: numeric(mark.price), bid: numeric(bidAsk.bid), ask: numeric(bidAsk.ask), status: typeof top.status === 'string' ? top.status : 'UNKNOWN' };
}
