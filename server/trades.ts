import fs from 'node:fs';
import path from 'node:path';
import type { IbkrClient } from './ibkr.js';
import { config } from './config.js';
import { filterTrades, TRADE_TIME_ZONE, type Trade, type TradesState, type TradeRange } from '../shared/trades.js';
import { tradeWindow } from './trade-ranges.js';
import { nextBackgroundRead } from './market-hours.js';
import { annotateTrades, enrichOrderTypes, optionRight, orderId, type TradeAnnotation } from './trade-options.js';

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const validTime = (value: unknown): value is string => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

export function normalizeTrades(raw: unknown): Trade[] {
  const rows = (raw as { trades?: unknown })?.trades;
  if (!Array.isArray(rows)) throw new Error('Missing trade list');
  const trades = new Map<string, Trade>();
  for (const row of rows) {
    const id = text(row?.trade_id);
    if (!id || !validTime(row?.trade_time)) throw new Error('Trade ID or timestamp is invalid');
    const right = ['OPT', 'FOP'].includes(row.sec_type) ? optionRight(row.option_right ?? row.put_call ?? row.right) ?? optionRight(row.contract_description) ?? (/\d{6}[CP]\d{8}/.test(row.symbol ?? '') ? optionRight(row.symbol) : null) : null;
    trades.set(id, { id, time: new Date(row.trade_time).toISOString(), symbol: text(row.symbol),
      name: text(row.company_name), assetClass: text(row.sec_type), side: text(row.side),
      size: amount(row.size), price: amount(row.price), currency: text(row.currency),
      netAmount: amount(row.net_amount), commission: amount(row.commission), orderId: orderId(row.order_id),
      optionRight: right, optionSource: right ? 'trade' : null, contractDescription: text(row.contract_description) });
  }
  return [...trades.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.id.localeCompare(b.id));
}

interface Archive { fetchedAt: string; trades: Trade[] }
const TTL = 300000;
// Closed markets keep a read until the shared slot, so an open tab costs no rotations.
const expired = (at: number, now: number) => now >= nextBackgroundRead(at, TTL);

function restoreArchive(saved: Archive, now: number): Archive {
  if (!validTime(saved.fetchedAt) || Date.parse(saved.fetchedAt) > now || !Array.isArray(saved.trades)) throw new Error('Invalid archive');
  const sources = new Map(saved.trades.map(t => [t.id, t.optionSource]));
  const trades = normalizeTrades({ trades: saved.trades.map(t => ({ trade_id: t.id, trade_time: t.time,
    symbol: t.symbol, company_name: t.name, sec_type: t.assetClass, side: t.side, size: t.size,
    price: t.price, currency: t.currency, net_amount: t.netAmount, commission: t.commission,
    order_id: t.orderId, option_right: t.optionRight, contract_description: t.contractDescription })) });
  for (const t of trades) {
    const source = sources.get(t.id);
    if (t.optionRight && (source === 'order' || source === 'user')) t.optionSource = source;
  }
  return { fetchedAt: saved.fetchedAt, trades };
}

export class TradeHistory {
  private caches: Record<string, Archive> = {};
  private pending = new Map<string, Promise<void>>();
  private attempts = new Map<string, number>();
  private errors = new Map<string, string>();
  private annotations: Record<string, TradeAnnotation> = {};
  private orders?: { at: number; raw: unknown };
  private ordersPending?: Promise<unknown>;
  private readonly file: string;
  constructor(private readonly client: Pick<IbkrClient, 'call'>, directory = config.dataDir, private readonly now = Date.now) {
    this.file = path.join(directory, 'trades.json');
    try {
      const annotations = path.join(directory, 'trade-annotations.json');
      if (fs.existsSync(annotations)) {
        const parsed = JSON.parse(fs.readFileSync(annotations, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.annotations = parsed;
      }
    } catch { /* Invalid annotations never imply a contract type. */ }
    if (!fs.existsSync(this.file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version === 1) this.caches.recent = restoreArchive(saved, this.now());
      else if (saved.version === 2 && saved.caches) {
        for (const [key, value] of Object.entries(saved.caches)) {
          if (key === 'recent' || /^year:\d{4}$/.test(key)) this.caches[key] = restoreArchive(value as Archive, this.now());
        }
      } else throw new Error('Invalid version');
    } catch { this.errors.set('recent', '本地成交记录读取失败，等待重新查询。'); }
  }
  view(range: TradeRange = 'previous'): TradesState {
    const now = this.now(), window = tradeWindow(range, now), cache = this.caches[window.key];
    const error = this.errors.get(window.key) ?? null;
    const trades = filterTrades(cache?.trades ?? [], now, window.startDate, window.endDate);
    return { trades: annotateTrades(trades, this.annotations), range, startDate: window.startDate, endDate: window.endDate,
      timeZone: TRADE_TIME_ZONE, fetchedAt: cache?.fetchedAt ?? null, refreshing: this.pending.has(window.key), error,
      stale: !cache || Boolean(error) || expired(Date.parse(cache.fetchedAt), now) };
  }
  read(range: TradeRange = 'previous'): TradesState { void this.refresh(false, range); return this.view(range); }
  /** Current year plus previously saved annual queries, for the funding reference. */
  yearHistory(): TradesState {
    const current = this.view('year'), year = current.endDate.slice(0, 4);
    const older = Object.entries(this.caches).filter(([key]) => /^year:\d{4}$/.test(key) && key.slice(5) < year);
    const trades = [...older.flatMap(([key, cache]) => filterTrades(cache.trades, this.now(), key.slice(5) + '-01-01', key.slice(5) + '-12-31')), ...current.trades];
    const startDate = older.length ? older.map(([key]) => key.slice(5) + '-01-01').sort()[0] : current.startDate;
    return { ...current, trades, startDate };
  }
  private commit(key: string, cache: Archive): void {
    const caches = { ...this.caches, [key]: cache };
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 2, caches }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.caches = caches;
  }
  private getOrders(): Promise<unknown> {
    if (this.orders && !expired(this.orders.at, this.now())) return Promise.resolve(this.orders.raw);
    this.ordersPending ??= this.client.call('get_account_orders', { show_completed: true })
      .catch(() => null).then(raw => { this.orders = { at: this.now(), raw }; return raw; })
      .finally(() => { this.ordersPending = undefined; });
    return this.ordersPending;
  }
  refresh(force = false, range: TradeRange = 'previous'): Promise<void> {
    const now = this.now(), window = tradeWindow(range, now), key = window.key, cache = this.caches[key];
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (!force && cache && !this.errors.has(key) && !expired(Date.parse(cache.fetchedAt), now)) return Promise.resolve();
    const lastAttempt = this.attempts.get(key);
    if (lastAttempt !== undefined && now - lastAttempt < (force ? 30000 : 60000)) return Promise.resolve();
    this.attempts.set(key, now);
    const operation = Promise.resolve().then(async () => {
      const rows: unknown[] = [];
      for (const period of window.periods) {
        const raw = await this.client.call('get_account_trades', { period }) as { trades?: unknown };
        if (!Array.isArray(raw?.trades)) throw new Error('Missing trade list');
        rows.push(...raw.trades);
      }
      const known = new Map(Object.values(this.caches).flatMap(entry => entry.trades).filter(t => t.optionRight).map(t => [t.id, t]));
      const trades = normalizeTrades({ trades: rows }).map(t => {
        const old = known.get(t.id);
        if (!t.optionRight && old && t.symbol === old.symbol && t.time === old.time && t.side === old.side && t.assetClass === old.assetClass) {
          return { ...t, optionRight: old.optionRight, optionSource: old.optionSource, contractDescription: old.contractDescription };
        }
        return t;
      });
      const next: Archive = { fetchedAt: new Date(this.now()).toISOString(), trades };
      this.commit(key, next);
      this.errors.delete(key);
      if (trades.some(t => ['OPT', 'FOP'].includes(t.assetClass ?? '') && t.orderId && !t.optionRight)) {
        try {
          const enriched = enrichOrderTypes(trades, await this.getOrders());
          if (enriched.some((t, i) => t !== trades[i])) this.commit(key, { ...next, trades: enriched });
        } catch { /* The trade list remains valid if contract details are unavailable. */ }
      }
    }).catch(() => {
      this.errors.set(key, this.caches[key] ? '成交记录刷新失败，以下保留上次成功记录。' : '成交记录暂时读取失败，请稍后刷新。');
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, operation);
    return operation;
  }
}
