import { useEffect, useState } from 'react';
import { X, ExternalLink } from 'lucide-react';
import type { DiscordSettings, DiscordStatus, PresenceSummary } from '../shared/discord';
import { discordArtwork } from './discord-artwork';

async function request<T>(url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    const response = await fetch('/api/session');
    if (!response.ok) throw new Error('请重新打开看板后再试');
    headers['X-CSRF-Token'] = (await response.json()).csrf;
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '请求失败');
  return value;
}

export function DiscordPanel({ close }: { close: () => void }) {
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [settings, setSettings] = useState<DiscordSettings | null>(null);
  const [preview, setPreview] = useState<PresenceSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  useEffect(() => {
    let active = true;
    async function read() {
      try {
        const value = await request<DiscordStatus>('/api/discord');
        if (active) { setStatus(value); setSettings(current => current ?? value.settings); setReadError(''); }
      } catch { if (active) setReadError('无法读取连接状态，正在重试'); }
    }
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  async function save() {
    setBusy(true); setError('');
    try { setStatus(await request<DiscordStatus>('/api/discord', settings)); setPreview(null); }
    catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }
  async function refreshPreview() {
    setBusy(true); setError('');
    try { setPreview(await request<PresenceSummary>('/api/discord/preview', { startDate: settings?.startDate, capitalUsd: settings?.capitalUsd })); }
    catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }
  const summary = preview ?? status?.summary;
  return <div className="modal-backdrop" onClick={close}>
    <section className="modal panel discord-modal" role="dialog" aria-modal="true" aria-label="Discord 动态状态" onClick={event => event.stopPropagation()}>
      <div className="panel-heading"><h2>Discord 动态状态</h2><button type="button" className="icon-button" onClick={close} aria-label="关闭 Discord 设置"><X size={18} /></button></div>
      <p className="muted">将账户摘要展示在你的 Discord 活动卡片中。本机 Discord 桌面端需保持登录。</p>
      {!settings ? <p>正在读取设置…</p> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label htmlFor="discord-app-id">Application ID</label>
        <input id="discord-app-id" value={settings.applicationId} onChange={event => setSettings({ ...settings, applicationId: event.target.value })} placeholder="Discord 应用的 17–20 位数字 ID" inputMode="numeric" pattern="[0-9]{17,20}" required={settings.enabled} autoComplete="off" />
        <a className="discord-portal" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">打开 Discord 开发者后台 <ExternalLink size={13} /></a>
        <p className="muted">创建应用后，在 General Information 中复制 Application ID；无需账号 Token。</p>
        <label htmlFor="discord-start-date">入市日期</label>
        <input id="discord-start-date" type="date" value={settings.startDate} required={settings.enabled} onChange={event => { setSettings({ ...settings, startDate: event.target.value }); setPreview(null); }} />
        <p className="muted">按北京时间自然日期相差计算，起始日为 0 天。累计收益使用该日起的 IB TWR。</p>
        <label htmlFor="discord-capital">USD 投入本金</label>
        <input id="discord-capital" type="number" min="0.01" step="any" value={settings.capitalUsd ?? ''} placeholder="确认后的美元净投入本金" onChange={event => setSettings({ ...settings, capitalUsd: event.target.value === '' ? undefined : Number(event.target.value), capitalConfirmedAt: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) })} />
        <p className="muted">填入后，总盈亏率按（净值－本金）÷本金计算；新入出金后需更新。未填写时沿用累计 TWR。</p>
        {settings.depositsCnh !== undefined && <p className="muted">已确认累计 CNH 入金：{settings.depositsCnh.toLocaleString()}；本金确认日期：{settings.capitalConfirmedAt}</p>}
        <label className="discord-enable"><input type="checkbox" checked={settings.enabled} onChange={event => setSettings({ ...settings, enabled: event.target.checked })} />开启 Discord 同步</label>
        <div className="discord-actions"><button className="button primary" disabled={busy}>保存并应用</button><button type="button" className="button secondary" disabled={busy || !settings.startDate} onClick={() => void refreshPreview()}>{busy ? '处理中…' : '刷新预览'}</button></div>
      </form>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {readError && <p className="form-error" role="alert">{readError}</p>}
      {status && <div className="discord-status" aria-live="polite">
        <p>同步：{!status.settings.enabled ? '未开启' : status.connected ? '已连接本机 Discord' : '等待 Discord 连接'}</p>
        <p className="muted">最近成功同步：{status.lastSentAt ? new Date(status.lastSentAt).toLocaleString('zh-CN') : '尚未发送'}</p>
        {status.error && <p className="amber">{status.error}</p>}
      </div>}
      {summary && <div className="discord-preview">
        {summary.activity?.largeImageKey && <div className="discord-artwork">
          <img src={discordArtwork[summary.activity.largeImageKey]} alt={summary.activity.largeImageText} />
          {summary.activity.smallImageKey && <img className="discord-artwork-badge" src={discordArtwork[summary.activity.smallImageKey]} alt={summary.activity.smallImageText} />}
        </div>}
        <span className="tiny">活动内容预览</span><h3>{summary.activity?.name ?? '我的投资账户'}</h3>
        {summary.activity ? <><p>{summary.activity.details}</p><p>{summary.activity.state}</p></> : <p>暂不展示活动，请检查入市日期和账户数据。</p>}
        <p className="muted">账户采集：{summary.accountAsOf ? new Date(summary.accountAsOf).toLocaleString('zh-CN') : '暂缺'}</p>
        {summary.total && <p>美元总盈亏：{summary.total.pnlUsd.toFixed(2)} USD（{summary.total.returnPct.toFixed(2)}%）；投入本金 {summary.total.capitalUsd.toFixed(2)} USD</p>}
        {summary.today && <p>今日净值变动：{summary.today.navChange.toFixed(2)} {summary.today.currency}（{summary.today.changePct.toFixed(2)}%），对比 {summary.today.previousDate} 收盘；有资金进出时不等于投资盈亏。</p>}
        {summary.history && <p className="muted">本地保存 {summary.history.records} 个业绩日，最新 {summary.history.latestDate}；IB 本次返回至 {summary.history.providerLatest ?? '暂缺'}</p>}
        <p className="muted">历史 TWR 起点：{summary.performance?.since ?? '待核实'}；上一交易日：{summary.performance?.date ?? '请刷新预览'}</p>
        {summary.warnings.map(warning => <p className="amber" key={warning}>{warning}</p>)}
      </div>}
      <p className="discord-note muted">可见范围由 Discord 的活动分享设置控制。数据过期时保留带时间的灰色快照；Mac 离线后活动会消失。</p>
    </section>
  </div>;
}
