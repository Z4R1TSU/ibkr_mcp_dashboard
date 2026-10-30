import type { PresenceSummary } from '../../shared/discord.js';

export class RemoteActivity {
  private summary?: PresenceSummary;
  private receivedAt = 0;
  private scope = '';
  private accountAt = -Infinity;
  private performanceDate = '';
  private generatedAt = -Infinity;
  error: string | null = null;
  accept(summary: PresenceSummary, applicationId: string, now = Date.now()): boolean {
    const scope = applicationId + ':' + (summary.currency ?? this.summary?.currency ?? '');
    if (scope !== this.scope) {
      this.scope = scope;
      this.summary = undefined;
      this.accountAt = -Infinity;
      this.performanceDate = '';
      this.generatedAt = -Infinity;
    }
    const generatedAt = Date.parse(summary.generatedAt);
    const accountAt = summary.accountAsOf === null ? -Infinity : Date.parse(summary.accountAsOf);
    const date = summary.performance?.date ?? '';
    if (!Number.isFinite(generatedAt) || generatedAt > now + 60000 || now - generatedAt >= 45000
      || Number.isNaN(accountAt) || accountAt > now + 60000) {
      this.error = '收到过期或无效的服务器摘要，等待最新数据';
      return false;
    }
    if (generatedAt < this.generatedAt || accountAt < this.accountAt || date && date < this.performanceDate) {
      this.error = '服务器数据日期回退，已拒绝覆盖较新的活动';
      return false;
    }
    this.accountAt = accountAt;
    this.generatedAt = generatedAt;
    if (date) this.performanceDate = date;
    this.summary = summary;
    this.receivedAt = now;
    this.error = null;
    return true;
  }
  disconnect() { this.receivedAt = 0; }
  get(now = Date.now()) {
    return this.summary && this.receivedAt > 0 && now >= this.receivedAt && now - this.receivedAt < 45000
      && now - Date.parse(this.summary.generatedAt) < 45000 ? this.summary.activity : null;
  }
}
