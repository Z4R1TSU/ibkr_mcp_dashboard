import type { DashboardState } from '../../shared/types.js';
import type { PresenceSummary } from '../../shared/discord.js';
import { latestPerformanceTradingDate, presencePerformance } from './performance.js';
import { validDate } from './settings.js';
import { presenceArtwork } from './artwork.js';
import { capitalReturn, navChange } from '../returns.js';
import { completedDay, newYorkDate } from '../daily-performance.js';
import { previousUsEquityTradingDate } from '../us-market-calendar.js';
import { FrozenPresenceStore } from './frozen.js';
import { freshFor } from '../market-hours.js';
import { presenceSession, presenceToday } from './today.js';

export function daysInvested(start: string, now: Date): number | null {
  if (!validDate(start)) return null;
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const days = Math.round((Date.parse(today) - Date.parse(start)) / 86400000);
  return days >= 0 ? days : null;
}
const percent = (n: number | null | undefined) => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const money = (value: number | null, currency: string | null, signed = false): string => {
  if (value === null || !Number.isFinite(value) || !currency) return '—';
  const amount = signed ? Math.abs(value) : value;
  return (signed ? value < 0 ? '-' : '+' : '') + (currency === 'USD' ? '$' : '')
    + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    + (currency === 'USD' ? '' : ' ' + currency);
};
const performanceScope = (raw: any) => JSON.stringify(Object.entries(raw?.accounts ?? {})
  .map(([id, account]) => [id, (account as any)?.base_currency]).sort());

export class PresenceData {
  private result?: { raw: unknown; date: string; fetchedAt: number; previousDate?: string };
  private error: string | null = null;
  private pending?: Promise<void>;
  constructor(private readonly view: () => DashboardState,
    private readonly performance: () => Promise<unknown>,
    private readonly completedDate: () => Promise<string>, private readonly previousDate?: () => Promise<string>,
    private readonly frozen = new FrozenPresenceStore(), initialData?: unknown,
    private readonly latestPerformance?: () => unknown) {
    if (initialData) {
      const now = new Date(), date = latestPerformanceTradingDate(initialData, null, now);
      if (validDate(date)) {
        this.frozen.capture(initialData, now);
        this.result = { raw: initialData, date, fetchedAt: now.getTime() };
      }
    }
  }
  refresh(now = new Date()): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = Promise.all([this.performance(), this.completedDate().catch(() => null)]).then(async ([raw, marketResult]) => {
      const marketDate = marketResult && completedDay(marketResult, now) ? marketResult : null;
      const archive = (raw as any)?.local_archive;
      const date = latestPerformanceTradingDate(raw, marketDate, now);
      if (!validDate(date)) throw new Error('没有可用的交易日期');
      if (this.result && date < this.result.date && performanceScope(raw) === performanceScope(this.result.raw)) {
        this.error = 'IB 返回较旧的 ' + date + ' 业绩，保留较新的 ' + this.result.date + ' 记录';
        return;
      }
      const previousDate = await this.previousDate?.().catch(() => undefined);
      this.frozen.capture(raw, now);
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
    const accountTime = Date.parse(snapshot?.fetchedAt ?? '');
    const stale = !snapshot || state.status.stale || !state.status.connected
      || !Number.isFinite(accountTime) || accountTime > now.getTime() + 60000
      || now.getTime() - accountTime > freshFor(accountTime, (state.status.staleSeconds ?? 180) * 1000);
    const days = daysInvested(startDate, now);
    const archive = (this.result?.raw as any)?.local_archive;
    const capitalMode = capitalUsd !== undefined;
    const total = capitalReturn(nav, currency, capitalUsd, snapshot?.fetchedAt ?? null);
    if (capitalMode && !total) warnings.push('USD 成本收益需要有效的美元账户净值');
    const historyCurrency = (Object.values((this.result?.raw as any)?.accounts ?? {}) as any[])[0]?.base_currency;
    const previous = historyCurrency === currency ? archive?.closingDays?.find((day: any) => day.date === this.result?.previousDate) : undefined;
    const today = navChange(nav, currency, newYorkDate(now).date, previous);
    const history = archive ? { latestDate: archive.latestDate, providerLatest: archive.providerLatest, offline: archive.offline, records: archive.records } : null;
    const yesterdayDate = previousUsEquityTradingDate(presenceSession(now).date);
    const frozen = this.result ? this.frozen.latest(this.result.raw, yesterdayDate, now) : null;
    const yesterday = frozen?.currency === currency ? frozen : null;
    const currentYesterday = archive?.closingDays?.find((day: any) => day.date === yesterday?.date);
    if (yesterday && Number.isFinite(currentYesterday?.returnPct)
      && currentYesterday.returnPct.toFixed(2) !== yesterday.returnPct.toFixed(2)) {
      warnings.push('IB 后续修订了 ' + yesterday?.date + ' 的收益；活动保留已固定快照，今日盈亏使用 IB 当前的当日基准');
    }
    const todayPnl = presenceToday(this.latestPerformance?.() ?? this.result?.raw, currency, now);
    if (todayPnl.status === 'pending') warnings.push('IB 当日业绩尚未返回；净值与当日盈亏独立更新，正在自动重试');
    if (todayPnl.status === 'stale') warnings.push('今日盈亏读取已超过 10 分钟，暂不把旧金额显示成当前值，正在自动重试');
    if (yesterday?.date !== yesterdayDate) warnings.push(yesterdayDate + ' 尚无可用的新快照；继续展示最近已封板收益，飞书日报数据准备完成后立即切换');
    if (todayPnl.status === 'flow_mismatch') warnings.push('今日净值变动与 TWR 不一致或基准日期不符，可能有资金进出；今日盈亏金额待核对');
    if (history && history.providerLatest && history.latestDate > history.providerLatest) warnings.push('IB 当前只返回到 ' + history.providerLatest + '；已保留本地 ' + history.latestDate + ' 的业绩');
    let performance: PresenceSummary['performance'] = null;
    if (this.result) {
      const parsed = presencePerformance(this.result.raw, this.result.date, startDate, !capitalMode);
      warnings.push(...parsed.warnings);
      if (parsed.currency === currency) {
        const record = archive?.closingDays?.find((day: any) => day.date === parsed.value.date);
        performance = { ...parsed.value, provisional: record?.provisional ?? this.result.date === newYorkDate(now).date,
          updatedAt: record?.fetchedAt };
      }
      else warnings.push('账户净值与收益基准币种不一致，收益率暂缺');
    }
    if (stale) warnings.push('账户数据已过期，第一行标为旧值；净值和总盈亏均为旧数据，采集时间见标题和看板');
    if (days === null) warnings.push('请设置入市日期');
    const asOf = Number.isFinite(accountTime) ? new Date(accountTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const todayText = todayPnl.status === 'ready' ? money(todayPnl.amount, currency, true)
      : { before_premarket: '待盘前', closed: '休市', pending: '待数据', stale: '待更新', flow_mismatch: '待核对' }[todayPnl.status];
    const navLabel = stale && snapshot ? '旧值' : '净值';
    const activity = {
      name: stale ? (asOf ? '账户快照 · ' + asOf : '我的投资账户 · 等待数据') : '我的投资账户 · ' + currency,
      ...presenceArtwork(yesterday?.returnPct, yesterday?.date ?? yesterdayDate),
      details: navLabel + ' ' + money(nav, currency) + ' · 总 ' + percent(capitalMode ? total?.returnPct : performance?.totalReturnPct),
      state: '今日 ' + todayText + ' · ' + (yesterday && yesterday.date !== yesterdayDate ? '上日(' : '昨日(') + (yesterday?.date ?? yesterdayDate).slice(5).replace('-', '/') + ') ' + (yesterday ? percent(yesterday.returnPct) : '—'),
    };
    return { version: 1, generatedAt: now.toISOString(), accountAsOf: snapshot?.fetchedAt ?? null,
      startDate, days, nav, currency, stale, performance, total, today, todayPnl, yesterdayDate, yesterday, history, warnings, activity };
  }
}
