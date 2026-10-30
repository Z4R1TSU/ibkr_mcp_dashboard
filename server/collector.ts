import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { IbkrClient } from './ibkr.js';
import { normalizeQuote, normalizeSnapshot } from './normalize.js';
import type { DashboardState, DeltaRisk } from '../shared/types.js';
import { dailyNavHistory, NAV_TIME_ZONE } from '../shared/nav-history.js';
import { readFailureReason } from './ibkr-fetch.js';
import { freshFor, marketActive, nextBackgroundRead } from './market-hours.js';
import { calculateDeltaRisk, deltaRiskView, positionKey, retainCompleteRisk } from './delta-risk.js';
import type { TosMarket } from './tos-market.js';

export const collectorDelay = (pollSeconds: number, failures: number, now = Date.now()) => failures
  ? Math.min(30000 * 2 ** Math.min(failures - 1, 2), 120000) : nextBackgroundRead(now, pollSeconds * 1000) - now;

export class Collector extends EventEmitter {
  private state: DashboardState = { snapshot: null, quotes: {}, history: [], status: { connected: false, refreshing: false, stale: true, lastAttempt: null, nextAttempt: null, error: null, quoteError: null, pollSeconds: config.pollSeconds, staleSeconds: config.staleSeconds, quoteBatchSize: config.quoteBatchSize } };
  private timer?: ReturnType<typeof setTimeout>;
  private lastDeltaRisk: DeltaRisk | null = null;
  private failures = 0;
  private running?: Promise<void>;
  private paused = false;
  private controller?: AbortController;
  private readonly file: string;
  private readonly historyTimeZone = NAV_TIME_ZONE;

  constructor(readonly client: IbkrClient, directory = config.dataDir, private readonly market?: TosMarket) {
    super();
    this.file = path.join(directory, 'dashboard.json');
    this.setMaxListeners(32);
    if (fs.existsSync(this.file)) {
      try {
        const stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as DashboardState & { lastDeltaRisk?: DeltaRisk };
        if (stored.snapshot?.version === 1 && Array.isArray(stored.history)) {
          this.state.snapshot = stored.snapshot;
          const previous = stored.lastDeltaRisk;
          if (previous?.version === 1 && previous.covered === previous.total && previous.leverage !== null
              && Number.isFinite(previous.leverage) && previous.nav !== null && previous.nav > 0
              && Array.isArray(previous.rows) && Array.isArray(previous.underlyings)) {
            this.lastDeltaRisk = previous;
            if (previous.positionKey === positionKey(stored.snapshot))
              this.state.deltaRisk = { ...previous, status: marketActive(Date.now()) ? 'reference' : 'historical', reason: '恢复上次完整快照，等待新数据' };
          }
          this.state.quotes = stored.quotes ?? {};
          this.state.history = stored.history.slice(-1440);
          this.state.dailyHistory = dailyNavHistory([...(stored.dailyHistory ?? []), ...stored.history], this.historyTimeZone);
        }
      } catch { this.state.status.error = '本地快照读取失败，等待 IB 重新拉取。'; }
    }
  }
  view(): DashboardState {
    const oldest = this.state.snapshot ? Math.min(...Object.values(this.state.snapshot.sources).map(value => Date.parse(value))) : 0;
    return { ...this.state, deltaRisk: deltaRiskView(this.state.deltaRisk, Date.now()), historyTimeZone: this.historyTimeZone, status: { ...this.state.status, connected: Boolean(this.client.oauth.vault.get().oauth?.tokens) && !this.client.oauth.vault.get().oauth?.loginRequired, stale: !Number.isFinite(oldest) || !oldest || Date.now() - oldest > freshFor(oldest, config.staleSeconds * 1000) } };
  }
  private sampleQuotes(): void {
    const quotes = { ...this.state.quotes };
    if (this.market) for (const position of this.state.snapshot?.positions ?? []) {
      const preferred = this.market.quote(position);
      if (preferred) quotes[position.id] = preferred;
      else if (quotes[position.id]) {
        const previous = quotes[position.id];
        quotes[position.id] = { ...previous, source: previous.source ?? 'ibkr',
          status: previous.source === 'thinkorswim' ? 'STALE' : previous.status, fallbackReason: this.market.reason };
      }
    }
    this.state.quotes = quotes;
  }
  private sampleRisk(): void {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    const now = Date.now();
    const requiresLogin = this.market?.requiresLogin?.() ?? false;
    const inputs = Object.fromEntries(snapshot.positions.filter(p => p.quantity !== 0).map(p => [p.id,
      this.market?.deltaInput?.(p) ?? { price: null, delta: null, reason: '嘉信风险行情不可用' }]));
    const risk = calculateDeltaRisk(snapshot, inputs, now, config.staleSeconds);
    if (risk.status === 'current' || risk.status === 'historical') this.lastDeltaRisk = risk;
    risk.requiresLogin = requiresLogin;
    if (risk.status === 'incomplete' && risk.rows.length && risk.rows.every(row => row.reason === risk.rows[0].reason)) risk.reason = risk.rows[0].reason;
    if (risk.requiresLogin) risk.reason = '嘉信会话已失效，需要重新登录';
    this.state.deltaRisk = retainCompleteRisk(risk, this.lastDeltaRisk);
  }
  private publish(): void { this.emit('change', this.view()); }
  private save(): void {
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ ...this.view(), lastDeltaRisk: this.lastDeltaRisk }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  start(): void {
    this.paused = false;
    void this.refresh();
  }
  async pause(): Promise<void> {
    this.paused = true;
    clearTimeout(this.timer);
    this.state.status.nextAttempt = null;
    this.controller?.abort(new DOMException('Collection paused', 'AbortError'));
    await this.running;
    await this.client.disconnect();
  }
  refresh(): Promise<void> {
    if (this.running) return this.running;
    if (this.paused) return Promise.resolve();
    clearTimeout(this.timer);
    this.controller = new AbortController();
    this.running = this.collect(this.controller.signal).finally(() => {
      this.running = undefined;
      this.controller = undefined;
      const delay = collectorDelay(config.pollSeconds, this.failures);
      if (!this.paused) {
        this.state.status.nextAttempt = new Date(Date.now() + delay).toISOString();
        this.timer = setTimeout(() => void this.refresh(), delay);
      }
      try { this.save(); } catch { console.warn(JSON.stringify({ event: 'collector_save_failed' })); }
      this.publish();
    });
    return this.running;
  }
  private async collect(signal: AbortSignal): Promise<void> {
    this.state.status.refreshing = true;
    this.state.status.phase = 'queued';
    this.state.status.nextAttempt = null;
    this.state.status.lastAttempt = new Date().toISOString();
    this.publish();
    try {
      const data = await this.client.readAccount(phase => {
        this.state.status.phase = phase; this.publish();
      }, signal);
      signal.throwIfAborted();
      const snapshot = normalizeSnapshot(data.positions, data.summary, data.balances, data.sources);
      try { this.market?.watch(snapshot.positions); } catch { console.warn('market_universe_update_failed'); }
      this.state.snapshot = snapshot;
      if (this.state.deltaRisk?.positionKey !== positionKey(snapshot)) this.state.deltaRisk = null;
      this.state.status.refreshing = false;
      this.state.status.phase = 'quotes';
      console.info(JSON.stringify({ event: 'collector_snapshot', fetchedAt: snapshot.fetchedAt, elapsedMs: Date.now() - Date.parse(this.state.status.lastAttempt!) }));
      this.state.status.error = null;
      this.failures = 0;
      if (snapshot.account.nav !== null) {
        const point = { time: snapshot.fetchedAt, nav: snapshot.account.nav };
        this.state.history = [...this.state.history, point].filter(point => Date.parse(point.time) > Date.now() - 7 * 86400000).slice(-1440);
        this.state.dailyHistory = dailyNavHistory([...(this.state.dailyHistory ?? []), point], this.historyTimeZone);
      }
      const held = new Set(snapshot.positions.map(position => String(position.id)));
      this.state.quotes = Object.fromEntries(Object.entries(this.state.quotes).filter(([id]) => held.has(id)));
      this.save();
      this.publish();
      this.state.status.quoteError = null;
      const eligible = snapshot.positions.filter(position => position.currency === 'USD' && (position.kind === 'stock' || position.kind === 'option') && !this.market?.quote(position));
      eligible.sort((first, second) => (this.state.quotes[first.id]?.fetchedAt ?? '').localeCompare(this.state.quotes[second.id]?.fetchedAt ?? ''));
      const quoteSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
      for (const position of eligible.slice(0, config.quoteBatchSize)) {
        if (quoteSignal.aborted) break;
        try {
          const raw = await this.client.call('get_price_snapshot', { contract_id: position.id, market_data_names: ['last', 'bid_ask', 'top_status', 'plprice'] }, { signal: quoteSignal });
          this.state.quotes[position.id] = normalizeQuote(position.id, raw, new Date().toISOString());
          this.publish();
        } catch {
          this.state.status.quoteError = '部分独立报价读取失败，保留旧报价及时间；账户快照不受影响。';
          break;
        }
      }
      this.save();
    } catch (error) {
      if (this.paused) return;
      console.info(JSON.stringify({ event: 'collector_failed', phase: this.state.status.phase, reason: readFailureReason(error), elapsedMs: Date.now() - Date.parse(this.state.status.lastAttempt!) }));
      this.failures += 1;
      this.state.status.error = this.client.oauth.vault.get().oauth?.tokens ? 'IB 读取失败。已保留上次成功快照，最多 2 分钟后自动重试。' : '尚未连接 IB。请完成 mcp.read 只读授权。';
    } finally {
      if (!this.paused) { this.sampleQuotes(); this.sampleRisk(); }
      this.state.status.refreshing = false;
      this.state.status.phase = 'idle';
      this.publish();
    }
  }
}
