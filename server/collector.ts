import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { IbkrClient } from './ibkr.js';
import { normalizeQuote, normalizeSnapshot } from './normalize.js';
import type { DashboardState } from '../shared/types.js';

export class Collector extends EventEmitter {
  private state: DashboardState = { snapshot: null, quotes: {}, history: [], status: { connected: false, refreshing: false, stale: true, lastAttempt: null, nextAttempt: null, error: null, quoteError: null, pollSeconds: config.pollSeconds, staleSeconds: config.staleSeconds, quoteBatchSize: config.quoteBatchSize } };
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private running?: Promise<void>;
  private paused = false;
  private readonly file: string;

  constructor(readonly client: IbkrClient, directory = config.dataDir) {
    super();
    this.file = path.join(directory, 'dashboard.json');
    this.setMaxListeners(32);
    if (fs.existsSync(this.file)) {
      try {
        const stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as DashboardState;
        if (stored.snapshot?.version === 1 && Array.isArray(stored.history)) {
          this.state.snapshot = stored.snapshot;
          this.state.quotes = stored.quotes ?? {};
          this.state.history = stored.history.slice(-1440);
        }
      } catch { this.state.status.error = '本地快照读取失败，等待 IB 重新拉取。'; }
    }
  }
  view(): DashboardState {
    const oldest = this.state.snapshot ? Math.min(...Object.values(this.state.snapshot.sources).map(value => Date.parse(value))) : 0;
    return { ...this.state, status: { ...this.state.status, connected: Boolean(this.client.oauth.vault.get().oauth?.tokens), stale: !oldest || Date.now() - oldest > config.staleSeconds * 1000 } };
  }
  private publish(): void { this.emit('change', this.view()); }
  private save(): void {
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  start(): void { this.paused = false; void this.refresh(); }
  async pause(): Promise<void> {
    this.paused = true;
    clearTimeout(this.timer);
    await this.running;
    await this.client.disconnect();
  }
  refresh(): Promise<void> {
    if (this.running) return this.running;
    if (this.paused) return Promise.resolve();
    clearTimeout(this.timer);
    this.running = this.collect().finally(() => {
      this.running = undefined;
      const delay = Math.min(config.pollSeconds * 1000 * 2 ** Math.min(this.failures, 5), 1800000);
      if (!this.paused) {
        this.state.status.nextAttempt = new Date(Date.now() + delay).toISOString();
        this.timer = setTimeout(() => void this.refresh(), delay);
      }
      this.publish();
    });
    return this.running;
  }
  private async collect(): Promise<void> {
    this.state.status.refreshing = true;
    this.state.status.lastAttempt = new Date().toISOString();
    this.publish();
    try {
      const positions = await this.client.call('get_account_positions');
      const positionTime = new Date().toISOString();
      const summary = await this.client.call('get_account_summary');
      const summaryTime = new Date().toISOString();
      const balances = await this.client.call('get_account_balances');
      const balanceTime = new Date().toISOString();
      const snapshot = normalizeSnapshot(positions, summary, balances, { positions: positionTime, summary: summaryTime, balances: balanceTime });
      this.state.snapshot = snapshot;
      this.state.status.error = null;
      this.failures = 0;
      if (snapshot.account.nav !== null) this.state.history = [...this.state.history, { time: snapshot.fetchedAt, nav: snapshot.account.nav }].filter(point => Date.parse(point.time) > Date.now() - 7 * 86400000).slice(-1440);
      const held = new Set(snapshot.positions.map(position => String(position.id)));
      this.state.quotes = Object.fromEntries(Object.entries(this.state.quotes).filter(([id]) => held.has(id)));
      this.save();
      this.publish();
      this.state.status.quoteError = null;
      const eligible = snapshot.positions.filter(position => position.currency === 'USD' && (position.kind === 'stock' || position.kind === 'option'));
      eligible.sort((first, second) => (this.state.quotes[first.id]?.fetchedAt ?? '').localeCompare(this.state.quotes[second.id]?.fetchedAt ?? ''));
      for (const position of eligible.slice(0, config.quoteBatchSize)) {
        try {
          const raw = await this.client.call('get_price_snapshot', { contract_id: position.id, market_data_names: ['last', 'bid_ask', 'top_status', 'plprice'] });
          this.state.quotes[position.id] = normalizeQuote(position.id, raw, new Date().toISOString());
          this.publish();
        } catch {
          this.state.status.quoteError = '部分独立报价读取失败，保留旧报价及时间；账户快照不受影响。';
          break;
        }
      }
      this.save();
    } catch {
      this.failures += 1;
      this.state.status.error = this.client.oauth.vault.get().oauth?.tokens ? 'IB 读取失败。已保留上次成功快照，自动退避重试；持续失败时请重新授权。' : '尚未连接 IB。请完成 mcp.read 只读授权。';
    } finally {
      this.state.status.refreshing = false;
      this.publish();
    }
  }
}
