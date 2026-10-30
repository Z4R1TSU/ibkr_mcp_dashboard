/** Funding reference inferred from FX executions, not confirmed bank transfers. */
export interface CashFlow {
  id: string;
  date: string;
  time: string;
  direction: 'deposit' | 'withdrawal';
  currency: 'USD';
  amount: number;
  counterCurrency: string;
  counterAmount: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  commission: number | null;
}

export interface CashFlowTotals {
  deposits: number;
  withdrawals: number;
  net: number;
}

export interface CashFlowExchangeRate {
  currency: string;
  /** Original-currency units per USD, weighted by the USD amount. */
  depositRate: number | null;
  withdrawalRate: number | null;
}

export interface CashFlowsState {
  records: CashFlow[];
  totals: CashFlowTotals;
  exchangeRates: CashFlowExchangeRate[];
  currency: 'USD';
  startDate: string;
  endDate: string;
  fetchedAt: string | null;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  skipped: number;
}

export const cashFlowLabel = (direction: CashFlow['direction']) => direction === 'deposit' ? '入金' : '出金';
export const cashFlowMoney = (amount: number) => amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });

export function cashFlowTotals(records: CashFlow[]): CashFlowTotals {
  const sum = (direction: CashFlow['direction']) => records.filter(row => row.direction === direction).reduce((total, row) => total + row.amount, 0);
  const deposits = sum('deposit'), withdrawals = sum('withdrawal');
  // Keep fractional-cent conversions; rounding every execution would lose them.
  const round = (value: number) => Math.round(value * 1e8) / 1e8;
  return { deposits: round(deposits), withdrawals: round(withdrawals), net: round(deposits - withdrawals) };
}

export function cashFlowExchangeRates(records: CashFlow[]): CashFlowExchangeRate[] {
  const groups = new Map<string, { bought: number; sold: number; spent: number; received: number }>();
  for (const row of records) {
    const total = groups.get(row.counterCurrency) ?? { bought: 0, sold: 0, spent: 0, received: 0 };
    if (row.direction === 'deposit') { total.bought += row.amount; total.spent += row.counterAmount; }
    else { total.sold += row.amount; total.received += row.counterAmount; }
    groups.set(row.counterCurrency, total);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({
    currency, depositRate: total.bought > 0 ? total.spent / total.bought : null,
    withdrawalRate: total.sold > 0 ? total.received / total.sold : null,
  }));
}
