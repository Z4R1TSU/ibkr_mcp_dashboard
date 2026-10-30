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
      <p className="muted">将账户摘要展示在你的 Discord 活动卡片中。Discord 桌面端需保持登录；服务器部署时使用 Mac 同步程序。</p>
      {status?.transport === 'remote' && <div className="discord-note">
        {status.macDownloadAvailable ? <a className="button secondary" href="/api/discord/mac-download" download>下载 Mac 同步程序</a> : <p>Mac 安装包尚未准备好。</p>}
        <p>在 Mac 解压后，双击 Install.command。需要 Node.js 24+ 和已登录的 Discord 桌面端；安装成功后登录自启。更新同步程序也使用此步骤。安装包含你的专用同步凭据，请私下保管。</p>
      </div>}
      {!settings ? <p>正在读取设置…</p> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label htmlFor="discord-app-id">Application ID</label>
        <input id="discord-app-id" value={settings.applicationId} onChange={event => setSettings({ ...settings, applicationId: event.target.value })} placeholder="Discord 应用的 17–20 位数字 ID" inputMode="numeric" pattern="[0-9]{17,20}" required={settings.enabled} autoComplete="off" />
        <a className="discord-portal" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">打开 Discord 开发者后台 <ExternalLink size={13} /></a>
        <p className="muted">创建应用后，在 General Information 中复制 Application ID；无需账号 Token。</p>
        <label htmlFor="discord-start-date">入市日期</label>
        <input id="discord-start-date" type="date" value={settings.startDate} required={settings.enabled} onChange={event => { setSettings({ ...settings, startDate: event.target.value }); setPreview(null); }} />
        <p className="muted">未填写 USD 净成本时，累计收益以此日期作为历史 TWR 起点；填写净成本后按成本计算。</p>
        <label htmlFor="discord-capital">USD 净投入成本</label>
        <input id="discord-capital" type="number" min="0.01" step="any" value={settings.capitalUsd ?? ''} placeholder="美元净投入成本" onChange={event => { setSettings({ ...settings, capitalUsd: event.target.value === '' ? undefined : Number(event.target.value), capitalConfirmedAt: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) }); setPreview(null); }} />
        <p className="muted">累计收益率 =（USD 净值－USD 净成本）÷ USD 净成本。新入出金后需更新成本；未填写时使用历史累计 TWR。</p>
        {settings.depositsCnh !== undefined && <p className="muted">已确认累计 CNH 入金：{settings.depositsCnh.toLocaleString()}；本金确认日期：{settings.capitalConfirmedAt}</p>}
        <label className="discord-enable"><input type="checkbox" checked={settings.enabled} onChange={event => setSettings({ ...settings, enabled: event.target.checked })} />开启 Discord 同步</label>
        <div className="discord-actions"><button className="button primary" disabled={busy}>保存并应用</button><button type="button" className="button secondary" disabled={busy || !settings.startDate} onClick={() => void refreshPreview()}>{busy ? '处理中…' : '刷新预览'}</button></div>
      </form>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {readError && <p className="form-error" role="alert">{readError}</p>}
      {status && <div className="discord-status" aria-live="polite">
        <p>同步：{!status.settings.enabled ? '未开启' : status.connected ? (status.transport === 'remote' ? 'Mac 同步已连接 Discord' : '已连接本机 Discord') : (status.transport === 'remote' ? '等待 Mac 同步程序' : '等待 Discord 连接')}</p>
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
        {summary.total && <p>美元累计盈亏：{summary.total.pnlUsd.toFixed(2)} USD（{summary.total.returnPct.toFixed(2)}%）；USD 净成本 {summary.total.capitalUsd.toFixed(2)}</p>}
        {summary.todayPnl?.amount != null && <p>今日盈亏：{summary.todayPnl.amount.toFixed(2)} {summary.currency}；IB 当日净值差与 TWR 已核对。读取时间：{summary.todayPnl.asOf ? new Date(summary.todayPnl.asOf).toLocaleString('zh-CN') : '暂缺'}</p>}
        {summary.history && <p className="muted">本地保存 {summary.history.records} 个业绩日，最新 {summary.history.latestDate}；IB 本次返回至 {summary.history.providerLatest ?? '暂缺'}</p>}
        <p className="muted">总盈亏口径：{summary.total ? 'USD 净投入成本' : '历史累计 TWR'}；展示快照日期：{summary.yesterday?.date ?? '暂无历史记录'}</p>
        {summary.yesterday && <p className="muted">已封板收益率 {summary.yesterday.returnPct.toFixed(2)}%；归档时间：{new Date(summary.yesterday.capturedAt).toLocaleString('zh-CN')}。后续 IB 修订不会覆盖这份快照。</p>}
        {summary.warnings.map(warning => <p className="amber" key={warning}>{warning}</p>)}
      </div>}
      <p className="discord-note muted">总仓位为含现金的账户净值。纽约 04:00 起展示今日金额，20:00 后切换下一日等待盘前；休市日显示“休市”，金额与 TWR 不符时显示“待核对”。昨日收益随飞书日报的数据生成立即封板并切换；没有可用新记录时继续显示最近已封板收益及真实日期。封面跟随所示快照。息屏仍继续同步。</p>
    </section>
  </div>;
}
