import type { IbkrClient } from './ibkr.js';
import fs from 'node:fs';
import path from 'node:path';
import { PerformanceStore } from './performance-store.js';
import { newYorkDate } from './daily-performance.js';
import { isUsEquityTradingDate } from './us-market-calendar.js';
import { nextBackgroundRead } from './market-hours.js';
import type { FrozenPresenceStore } from './discord/frozen.js';

export const performanceRetryDelay = (failures: number, now = Date.now()) => failures
  ? Math.min(30000 * 2 ** Math.min(failures - 1, 2), 120000) : nextBackgroundRead(now, 300000) - now;

/** One shared read/cache for reports and presence; never creates another IB session. */
export class PerformanceSource {
  private cached?: { data: unknown; expiresAt: number };
  private pending?: Promise<unknown>;
  private store: PerformanceStore;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private failures = 0;
  constructor(private readonly client: Pick<IbkrClient, 'call'>, private readonly directory?: string,
    private readonly snapshots?: Pick<FrozenPresenceStore, 'history'>) { this.store = new PerformanceStore(directory); }
  peek(): unknown | undefined {
    if (this.cached) return this.cached.data;
    try { return this.store.view(true); } catch { return undefined; }
  }
  calendar(month: string, now = new Date()) {
    return { ...this.store.calendar(month, now, this.snapshots), refreshing: Boolean(this.pending),
      offline: !this.cached || this.failures > 0 };
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.get().catch(() => undefined);
  }
  private schedule(delay = performanceRetryDelay(this.failures)) {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.stopped) this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.get().catch(() => undefined);
    }, delay);
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; await this.pending?.catch(() => undefined); }
  get(): Promise<unknown> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      if (!this.stopped && !this.timer) this.schedule(this.failures ? this.cached.expiresAt - Date.now() : performanceRetryDelay(0));
      return Promise.resolve(this.cached.data);
    }
    if (this.pending) return this.pending;
    clearTimeout(this.timer); this.timer = undefined;
    this.pending = Promise.resolve().then(() => this.client.call('get_pa_performance_all_periods')).then(data => {
      const observed = new Date();
      if (this.directory) {
        const file = path.join(this.directory, 'pa-performance-latest.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify({ fetchedAt: observed.toISOString(), data }), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
      }
      const merged = this.store.ingest(data, observed) as any;
      const ny = newYorkDate(observed);
      const needsToday = isUsEquityTradingDate(ny.date) && ny.hour >= 4 && ny.hour < 20;
      const currentDay = merged.local_archive?.currentDay;
      const missingToday = needsToday && (currentDay?.date !== ny.date || currentDay?.asOf !== observed.toISOString());
      this.failures = missingToday ? this.failures + 1 : 0;
      if (missingToday) console.warn(JSON.stringify({ event: 'performance_missing_today', date: ny.date,
        lastAsOf: currentDay?.asOf ?? null, retryMs: performanceRetryDelay(this.failures) }));
      // While closed, a read stays current until the shared slot instead of costing another rotation.
      this.cached = { data: merged, expiresAt: this.failures ? Date.now() + performanceRetryDelay(this.failures) : nextBackgroundRead(Date.now(), 60000) };
      return merged;
    }).catch(() => {
      this.failures++;
      console.warn(JSON.stringify({ event: 'performance_refresh_failed', retryMs: performanceRetryDelay(this.failures) }));
      const saved = this.store.view(true);
      this.cached = { data: saved, expiresAt: Date.now() + performanceRetryDelay(this.failures) }; return saved;
    }).finally(() => { this.pending = undefined; this.schedule(); });
    return this.pending;
  }
}
