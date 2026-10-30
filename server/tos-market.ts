import fs from 'node:fs';
import path from 'node:path';
import type { DeltaInput, Position, Quote, RiskObservation } from '../shared/types.js';
import type { DailyBar } from './daily-market.js';
import { completedDay, newYorkDate } from './daily-performance.js';
import { isUsEquityTradingDate } from './us-market-calendar.js';
import type { BrokerAuthState } from '../shared/broker-auth.js';

const base = ['AAPL', 'SPY', 'QQQ', 'DIA', 'IWM'];
export function tosSymbol(position: Position): string | null {
  if (position.currency !== 'USD') return null;
  if (position.kind === 'stock') return /^[A-Z]{1,10}$/.test(position.symbol) ? position.symbol : null;
  const o = position.option;
  if (position.kind !== 'option' || !o || o.multiplier !== 100 || !/^[A-Z]{1,10}$/.test(o.underlying)
      || !/^\d{4}-\d{2}-\d{2}$/.test(o.expiry) || !Number.isFinite(o.strike) || o.strike <= 0) return null;
  const expiry = new Date(o.expiry + 'T00:00:00Z');
  if (!Number.isFinite(expiry.getTime()) || expiry.toISOString().slice(0, 10) !== o.expiry) return null;
  return '.' + o.underlying + o.expiry.slice(2).replaceAll('-', '') + o.right + o.strike.toFixed(3).replace(/\.?0+$/, '');
}
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const age = (value: unknown, now: number) => typeof value === 'string' ? now - Date.parse(value) : Infinity;
const fresh = (value: unknown, now: number, ttl: number) => Number.isFinite(age(value, now)) && age(value, now) >= -5000 && age(value, now) <= ttl;
function usable(row: any, option: boolean) {
  const v = row?.values;
  if (!v) return false;
  if (option) return numeric(v.BID) !== null && numeric(v.ASK) !== null && v.BID >= 0 && v.ASK > 0 && v.BID <= v.ASK;
  return [v.MARK, v.LAST].some(x => numeric(x) !== null && x > 0);
}

export class TosMarket {
  private cached: any = null;
  private checked = 0;
  private universe = '';
  reason = '嘉信未连接';
  constructor(readonly directory: string, private readonly clock = Date.now) {}
  private read(file: string) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.() || stat.size > 16 * 1024 * 1024) throw new Error('invalid_cache');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  private cache() {
    const now = this.clock();
    if (now - this.checked >= 1000 || !this.checked) {
      this.checked = now;
      try { this.cached = this.read(path.join(this.directory, 'market-cache.json')); }
      catch { this.cached = null; }
    }
    if (!this.cached?.status?.connected || !fresh(this.cached.status.lastFrameAt, now, 20000)) {
      this.reason = this.cached?.status?.state === 'login_required' ? '嘉信会话已失效，需要重新登录' : '嘉信行情连接中断，正在重连';
      return null;
    }
    return this.cached;
  }
  requiresLogin(): boolean {
    return this.authStatus() === 'login_required';
  }
  authStatus(): BrokerAuthState {
    const cache = this.cache();
    if (this.cached?.status?.state === 'login_required') return 'login_required';
    return cache && cache.status.state === 'connected' ? 'ready' : 'unknown';
  }
  watch(positions: Position[]) {
    const quotes = [...new Set([...base, ...positions.filter(p => p.quantity !== 0 && p.currency === 'USD').map(p => p.option?.underlying ?? p.symbol).filter(s => /^[A-Z]{1,10}$/.test(s)), ...positions.map(tosSymbol).filter((v): v is string => v !== null)])].sort().slice(0, 200);
    const history = [...new Set([...base, ...positions.filter(p => p.currency === 'USD')
      .map(p => p.option?.underlying ?? p.symbol).filter(s => /^[A-Z]{1,10}$/.test(s))])].sort().slice(0, 100);
    const body = JSON.stringify({ quotes, history });
    if (body === this.universe) return;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'universe.json');
    fs.writeFileSync(file + '.tmp', body, { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    this.universe = body;
  }
  quote(position: Position): Quote | null {
    const symbol = tosSymbol(position);
    if (!symbol) { this.reason = '合约暂未匹配嘉信'; return null; }
    const cache = this.cache();
    if (!cache) return null;
    const now = this.clock();
    const candidates = [cache.quotes?.[symbol], cache.snapshotQuotes?.[symbol]];
    const row = candidates.find(r => r?.symbol === symbol && fresh(r.confirmedAt ?? r.receivedAt, now, 120000) && usable(r, position.kind === 'option'));
    if (!row) { this.reason = '嘉信该标的报价缺失或过期'; return null; }
    const v = row.values;
    return { id: position.id, source: 'thinkorswim', fetchedAt: row.confirmedAt ?? row.receivedAt,
      last: numeric(v.LAST), mark: numeric(v.MARK), bid: numeric(v.BID), ask: numeric(v.ASK),
      lastTradeAt: row.sourceTime ?? null, lastIsClose: null,
      status: row.isDelayed === false ? 'REALTIME' : row.isDelayed === true ? 'DELAYED' : 'UNKNOWN' };
  }
  deltaInput(position: Position): DeltaInput {
    const missing = (reason: string): DeltaInput => ({ price: null, delta: null, reason });
    const symbol = tosSymbol(position);
    if (!symbol) return missing('未匹配的标准股票或期权合约');
    const cache = this.cache();
    if (!cache) return missing(this.reason);
    const now = this.clock(), underlying = position.option?.underlying ?? position.symbol;
    const observation = (row: any, field: string): RiskObservation | null => {
      const value = numeric(row?.values?.[field]), receivedAt = row?.fieldTimes?.[field];
      if (value === null || !fresh(receivedAt, now, 120000)) return null;
      return { value, receivedAt, sourceTime: row.sourceTime ?? null, source: 'thinkorswim',
        status: row.isDelayed === false ? 'REALTIME' : row.isDelayed === true ? 'DELAYED' : 'UNKNOWN' };
    };
    const prices = [cache.quotes?.[underlying], cache.snapshotQuotes?.[underlying]]
      .filter(r => r?.symbol === underlying).flatMap(r => [observation(r, 'MARK'), observation(r, 'LAST')])
      .filter((r): r is RiskObservation => !!r && r.value > 0)
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const price = prices[0] ?? null;
    if (position.kind === 'stock') return { price, delta: null, reason: price ? null : '正股报价缺失或过期' };
    const row = cache.holdingGreeks?.[symbol], o = position.option!;
    const matched = row?.symbol === symbol && row.deltaBasis === 'per-share-feed-v1' && row.multiplier === o.multiplier
      && row.sharesPerContract === 100 && row.contract?.underlying === o.underlying && row.contract?.expiry === o.expiry
      && row.contract?.strike === o.strike && row.contract?.right === o.right;
    const delta = matched ? observation(row, 'DELTA') : null;
    return { price, delta, reason: !price ? '正股报价缺失或过期' : !matched ? 'Delta 单位或标准合约未核验' : !delta ? 'Delta 缺失或过期' : null };
  }
  history(symbol: string): DailyBar[] | null {
    if (!/^[A-Z]{1,10}$/.test(symbol) || !this.cache()) return null;
    try {
      const row = this.read(path.join(this.directory, 'history', symbol + '.json'));
      if (row.symbol !== symbol || row.interval !== '1d' || row.session !== 'regular'
          || row.adjustment !== 'split'
          || !fresh(row.receivedAt, this.clock(), 1800000) || !Array.isArray(row.bars) || row.bars.length < 2) return null;
      const now = new Date(this.clock()), cursor = new Date(newYorkDate(now).date + 'T00:00:00Z');
      while (!isUsEquityTradingDate(cursor.toISOString().slice(0, 10)) || !completedDay(cursor.toISOString().slice(0, 10), now)) cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (!row.bars.some((bar: any) => bar.date === cursor.toISOString().slice(0, 10))) return null;
      const seen = new Set<string>();
      return row.bars.map((bar: any): DailyBar => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date) || seen.has(bar.date)
            || !(numeric(bar.open) !== null && bar.open > 0 && numeric(bar.close) !== null && bar.close > 0)) throw new Error('bad_bar');
        seen.add(bar.date);
        return { date: bar.date, time: new Date(bar.timestamp).toISOString(), open: bar.open, close: bar.close,
          corporateActions: (row.corporateActions ?? []).filter((a: any) => a.date === bar.date).map((a: any) => String(a.type)),
          source: 'thinkorswim', adjustment: row.adjustment };
      });
    } catch { return null; }
  }
}
