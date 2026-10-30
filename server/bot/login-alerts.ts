import { randomUUID } from 'node:crypto';
import type { BrokerAuthState, BrokerId, LoginAlertStatus } from '../../shared/broker-auth.js';
import type { BotConfig } from './config.js';
import { BotStore, type LoginAlertIncident } from './store.js';
import type { BotTransport } from './transport.js';

const brokers: BrokerId[] = ['ibkr', 'schwab'];

/** Model requests and daily reports cannot delay this separate scheduler. */
export class LoginAlerts {
  private timer?: ReturnType<typeof setInterval>;
  private readonly pending = new Map<BrokerId, Promise<void>>();
  private lastCheckAt: string | null = null;
  private readonly states: Record<BrokerId, BrokerAuthState> = { ibkr: 'unknown', schwab: 'unknown' };
  private readonly errors: Record<BrokerId, string | null> = { ibkr: null, schwab: null };

  constructor(private readonly config: BotConfig, private readonly store: BotStore,
    private readonly read: (broker: BrokerId) => BrokerAuthState,
    private readonly transport: BotTransport, private readonly onSent: (at: string) => void = () => {}) {}

  status(): LoginAlertStatus {
    const status = (broker: BrokerId): LoginAlertStatus['brokers'][BrokerId] => {
      const incident = this.store.state.loginAlerts?.[broker];
      return { state: this.states[broker], detectedAt: incident?.detectedAt ?? null,
        sentAt: incident?.sentAt ?? null, pending: !!incident && !incident.resolvedAt && !incident.sentAt,
        error: this.errors[broker] };
    };
    return { enabled: true, running: !!this.timer, lastCheckAt: this.lastCheckAt,
      brokers: { ibkr: status('ibkr'), schwab: status('schwab') } };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.check(); }, 30000);
    void this.check();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all(this.pending.values());
  }

  async check(now = new Date()): Promise<void> {
    this.lastCheckAt = now.toISOString();
    // Each broker has its own in-flight guard, including across timer ticks.
    await Promise.all(brokers.map(broker => {
      const existing = this.pending.get(broker);
      if (existing) return existing;
      const task = this.checkBroker(broker, now).catch(() => {
        this.errors[broker] = '登录提醒检查或发送失败，稍后重试';
        console.warn(JSON.stringify({ event: 'broker_login_alert', broker, outcome: 'failed' }));
      }).finally(() => { this.pending.delete(broker); });
      this.pending.set(broker, task);
      return task;
    }));
  }

  private async checkBroker(broker: BrokerId, now: Date): Promise<void> {
    const state = this.read(broker);
    this.states[broker] = state;
    const owner = this.store.state.ownerOpenId;
    let incident = this.store.state.loginAlerts?.[broker];
    if (state === 'ready') {
      if (incident && !incident.resolvedAt) {
        incident.resolvedAt = now.toISOString();
        this.store.save(now.getTime());
      }
      this.errors[broker] = null;
      return;
    }
    // Unknown/disabled never resolve an outstanding login failure.
    if (state !== 'login_required' || !owner) return;
    if (!incident || incident.resolvedAt) {
      incident = { id: randomUUID(), detectedAt: now.toISOString(), sentAt: null };
      (this.store.state.loginAlerts ??= {})[broker] = incident;
    }
    if (incident.sentAt) return;
    // Commit the identity before sending so retries survive restarts.
    this.store.save(now.getTime());
    await this.transport.send(owner, this.message(broker, incident), 'login-alert:' + broker + ':' + incident.id);
    incident.sentAt = now.toISOString();
    try { this.store.save(now.getTime()); }
    catch (error) { incident.sentAt = null; throw error; }
    this.errors[broker] = null;
    this.onSent(incident.sentAt);
    console.info(JSON.stringify({ event: 'broker_login_alert', broker, outcome: 'sent' }));
  }

  private message(broker: BrokerId, incident: LoginAlertIncident): string {
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone: this.config.timeZone,
      dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date(incident.detectedAt));
    const details = broker === 'ibkr'
      ? ['IBKR 授权已失效或缺失，需要重新登录。', '账户数据无法继续更新，已保留上次成功快照。',
        '打开看板，点击“连接 IB”完成只读授权：', this.config.publicUrl]
      : ['嘉信（Schwab）会话已失效或缺失，需要重新登录。', '嘉信行情及依赖它的实时风险数据暂不可用。',
        '打开嘉信登录入口，完成登录和验证：', new URL('/tos-login/', this.config.publicUrl).href];
    return [...details, '发现时间：' + time + '（' + this.config.timeZone + '）', '本次失效只提醒一次，恢复登录后重新监测。'].join('\n');
  }
}
