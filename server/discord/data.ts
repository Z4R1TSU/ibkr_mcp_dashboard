import type { DashboardState } from '../../shared/types.js';
import type { PresenceSummary } from '../../shared/discord.js';
import { presencePerformance } from './performance.js';
import { validDate } from './settings.js';
import { presenceArtwork } from './artwork.js';
import { capitalReturn, navChange } from '../returns.js';
import { newYorkDate } from '../daily-performance.js';

export function daysInvested(start: string, now: Date): number | null {
  if (!validDate(start)) return null;
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const days = Math.round((Date.parse(today) - Date.parse(start)) / 86400000);
  return days >= 0 ? days : null;
}
const percent = (n: number | null | undefined) => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

export class PresenceData {
  private result?: { raw: unknown; date: string; fetchedAt: number; previousDate?: string };
  private error: string | null = null;
  private pending?: Promise<void>;
  constructor(private readonly view: () => DashboardState,
    private readonly performance: () => Promise<unknown>,
    private readonly completedDate: () => Promise<string>, private readonly previousDate?: () => Promise<string>) {}
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = Promise.all([this.performance(), this.completedDate().catch(() => null)]).then(async ([raw, marketDate]) => {
      const archive = (raw as any)?.local_archive;
      const date = archive?.latestDate ?? marketDate;
      if (!validDate(date)) throw new Error('没有可用的交易日期');
      const previousDate = await this.previousDate?.().catch(() => undefined);
      this.result = { raw, date, fetchedAt: Date.now(), previousDate };
      this.error = archive?.offline ? 'IB 业绩暂不可用，使用本地历史'
        : marketDate && date < marketDate ? marketDate + ' 业绩尚未到达，暂用 ' + date + ' 的本地记录'
        : !marketDate ? '交易日历暂不可用，使用本地最新完成日' : null;
    }).catch(() => { this.error = '收益更新失败，保留上次数据并自动重试'; })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
  summary(startDate: string, now = new Date(), capitalUsd?: number): PresenceSummary {
    const state = this.view();
    const snapshot = state.snapshot;
    const warnings: string[] = this.error ? [this.error] : [];
    const nav = snapshot?.account.nav ?? null;
    const currency = snapshot?.account.currency ?? null;
    const stale = !snapshot || state.status.stale || !state.status.connected;
    const days = daysInvested(startDate, now);
    const archive = (this.result?.raw as any)?.local_archive;
    const total = capitalReturn(nav, currency, capitalUsd, snapshot?.fetchedAt ?? null);
    const historyCurrency = (Object.values((this.result?.raw as any)?.accounts ?? {}) as any[])[0]?.base_currency;
    const previous = historyCurrency === currency ? archive?.closingDays?.find((day: any) => day.date === this.result?.previousDate) : undefined;
    const today = navChange(nav, currency, newYorkDate(now).date, previous);
    const history = archive ? { latestDate: archive.latestDate, providerLatest: archive.providerLatest, offline: archive.offline, records: archive.records } : null;
    if (history && history.providerLatest && history.latestDate > history.providerLatest) warnings.push('IB 当前只返回到 ' + history.providerLatest + '；已保留本地 ' + history.latestDate + ' 的业绩');
    let performance: PresenceSummary['performance'] = null;
    if (this.result) {
      const parsed = presencePerformance(this.result.raw, this.result.date, startDate);
      warnings.push(...parsed.warnings);
      if (parsed.currency === currency) performance = parsed.value;
      else warnings.push('账户净值与收益基准币种不一致，收益率暂缺');
    }
    if (stale) warnings.push('当前显示旧快照，采集时间见活动标题；Mac 离线时活动仍会消失');
    if (days === null) warnings.push('请设置入市日期');
    const hasAccount = Number.isFinite(nav) && currency !== null;
    const asOf = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const activity = days !== null ? {
      name: stale ? (asOf ? '账户快照 · ' + asOf : '我的投资账户 · 等待数据') : '我的投资账户 · ' + currency,
      ...presenceArtwork(stale || this.error ? null : performance?.dailyReturnPct, performance?.date),
      ...(stale ? { largeImageText: asOf ? '旧快照，账户采集于 ' + asOf : '等待 IB 账户数据', smallImageText: '数据待更新' } : {}),
      details: '入市' + days + '天 · ' + (hasAccount ? (currency === 'USD' ? '$' : '')
        + nav!.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        + (currency === 'USD' ? '' : ' ' + currency) : '账户 —'),
      state: (total ? '总 ' + percent(total.returnPct) : '累计 ' + percent(performance?.totalReturnPct)) + ' · ' + (performance?.date.slice(5).replace('-', '/') ?? '上日') + ' ' + percent(performance?.dailyReturnPct),
    } : null;
    return { version: 1, generatedAt: now.toISOString(), accountAsOf: snapshot?.fetchedAt ?? null,
      startDate, days, nav, currency, stale, performance, total, today, history, warnings, activity };
  }
}
