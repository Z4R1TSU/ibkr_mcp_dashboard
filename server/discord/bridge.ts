import type { DiscordSettings, PresenceActivity } from '../../shared/discord.js';
import { createPresenceConnection, type PresenceConnection } from './rpc.js';

export async function bounded<T>(work: Promise<T>, milliseconds = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Discord 请求超时')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

export class DiscordBridge {
  private connection?: PresenceConnection;
  private applicationId = '';
  private sent: string | undefined;
  private pending?: Promise<void>;
  private resync = false;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  lastSentAt: string | null = null;
  error: string | null = null;
  constructor(private readonly settings: () => DiscordSettings,
    private readonly activity: () => PresenceActivity | null,
    private readonly create = createPresenceConnection,
    private readonly now = () => Date.now()) {}
  get connected() { return this.connection?.connected ?? false; }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.sync(), 10000);
    void this.sync();
  }
  private async disconnect() {
    const connection = this.connection;
    this.connection = undefined;
    this.sent = undefined;
    if (connection?.connected) await bounded(connection.send(null), 1500).catch(() => undefined);
    if (connection) await bounded(connection.close(), 2000).catch(() => undefined);
  }
  async reset() {
    await this.pending;
    await this.disconnect();
    this.error = null;
    if (!this.stopped) void this.sync();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pending;
    await this.disconnect();
  }
  sync(): Promise<void> {
    this.resync = true;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      do { this.resync = false; await this.run(); } while (this.resync);
    })().catch(async error => {
      this.error = 'Discord 同步失败，请确认 Application ID 和桌面端已登录；将自动重试'
        + (typeof error?.code === 'number' ? '（' + error.code + '）' : '');
      await this.disconnect();
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async run() {
    const settings = this.settings();
    if (this.stopped || !settings.enabled) { await this.disconnect(); return; }
    if (!this.activity()) { await this.disconnect(); this.error = null; return; }
    if (!this.connection?.connected || settings.applicationId !== this.applicationId) {
      await this.disconnect();
      this.applicationId = settings.applicationId;
      this.connection = this.create(settings.applicationId);
      await bounded(this.connection.connect());
    }
    const current = this.settings();
    const connection = this.connection;
    if (this.stopped || !current.enabled || current.applicationId !== settings.applicationId || !connection?.connected) return;
    const activity = this.activity();
    if (!activity) { await this.disconnect(); return; }
    const fingerprint = JSON.stringify(activity);
    // Reassert even unchanged content: a live IPC socket does not prove Discord
    // retained the activity through desktop/network suspension.
    if (activity && this.sent && this.sent !== 'null' && this.lastSentAt
      && this.now() - Date.parse(this.lastSentAt) < 60000) return;
    await bounded(connection.send(activity));
    this.sent = fingerprint;
    this.error = null;
    if (activity) this.lastSentAt = new Date(this.now()).toISOString();
  }
}
