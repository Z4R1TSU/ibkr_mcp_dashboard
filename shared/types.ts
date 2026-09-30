export interface SessionInfo {
  authenticated: boolean;
  csrf: string | null;
  accessMode: 'local' | 'password';
}
export type Amount = number | null;
export interface OptionContract {
  underlying: string;
  expiry: string;
  right: 'C' | 'P';
  strike: number;
  multiplier: number;
}
export interface Position {
  id: number;
  description: string;
  symbol: string;
  brokerAssetClass: string | null;
  kind: 'stock' | 'option' | 'other';
  currency: string;
  quantity: Amount;
  price: Amount;
  value: Amount;
  averagePrice: Amount;
  unrealizedPnl: Amount;
  navWeight: Amount;
  option: OptionContract | null;
}
export interface Account {
  currency: string;
  nav: Amount;
  cash: Amount;
  buyingPower: Amount;
  availableFunds: Amount;
  equityWithLoan: Amount;
  initialMargin: Amount;
  maintenanceMargin: Amount;
  excessLiquidity: Amount;
  grossPositionValue: Amount;
  dividends: Amount;
  leverage: Amount;
  unrealizedPnl: Amount;
  realizedPnl: Amount;
}
export interface Balance {
  currency: string;
  cash: Amount;
  settledCash: Amount;
  unrealizedPnl: Amount;
}
export interface OptionRisk {
  id: number;
  underlying: string;
  currency: string;
  expiry: string;
  right: 'C' | 'P';
  strike: number;
  multiplier: number;
  contracts: number;
  shares: number;
  strikeNotional: number;
  matchedShares: number | null;
  unmatchedShares: number | null;
}
export interface Analysis {
  allBaseCurrency: boolean;
  grossAbsoluteValue: Amount;
  netPositionValue: Amount;
  stockValue: Amount;
  optionValue: Amount;
  stockPnl: Amount;
  optionPnl: Amount;
  totalPositionPnl: Amount;
  topThreeWeight: Amount;
  cashRatio: Amount;
  marginBufferRatio: Amount;
  shortPutNotional: Amount;
  shortPutCashGap: Amount;
  residual: Amount;
  options: OptionRisk[];
  warnings: string[];
}
export interface Quote {
  id: number;
  fetchedAt: string;
  last: Amount;
  lastTradeAt: string | null;
  lastIsClose: boolean | null;
  mark: Amount;
  bid: Amount;
  ask: Amount;
  status: string;
}
export interface Snapshot {
  version: 1;
  fetchedAt: string;
  sources: { positions: string; summary: string; balances: string };
  account: Account;
  balances: Balance[];
  positions: Position[];
  analysis: Analysis;
}
export interface DashboardState {
  snapshot: Snapshot | null;
  quotes: Record<string, Quote>;
  history: { time: string; nav: number }[];
  status: {
    connected: boolean;
    refreshing: boolean;
    stale: boolean;
    lastAttempt: string | null;
    nextAttempt: string | null;
    error: string | null;
    quoteError: string | null;
    pollSeconds: number;
    staleSeconds: number;
    quoteBatchSize: number;
  };
}
