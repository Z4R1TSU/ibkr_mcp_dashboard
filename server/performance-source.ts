import type { IbkrClient } from './ibkr.js';
import fs from 'node:fs';
import path from 'node:path';
import { PerformanceStore } from './performance-store.js';

/** One shared read/cache for reports and presence; never creates another IB session. */
export class PerformanceSource {
  private cached?: { data: unknown; at: number };
  private pending?: Promise<unknown>;
  private store: PerformanceStore;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  constructor(private readonly client: Pick<IbkrClient, 'call'>, private readonly directory?: string) { this.store = new PerformanceStore(directory); }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      await this.get().catch(() => undefined);
      if (!this.stopped) this.timer = setTimeout(() => void tick(), 300000);
    };
    void tick();
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.pending?.catch(() => undefined); }
  get(): Promise<unknown> {
    if (this.cached && Date.now() - this.cached.at < 60000) return Promise.resolve(this.cached.data);
    if (this.pending) return this.pending;
    this.pending = this.client.call('get_pa_performance_all_periods').then(data => {
      if (this.directory) {
        const file = path.join(this.directory, 'pa-performance-latest.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify({ fetchedAt: new Date().toISOString(), data }), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
      }
      const merged = this.store.ingest(data);
      this.cached = { data: merged, at: Date.now() }; return merged;
    }).catch(() => {
      const saved = this.store.view(true);
      this.cached = { data: saved, at: Date.now() }; return saved;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
