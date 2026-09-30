import React, { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Database, ExternalLink, LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Radio, RefreshCw, Search, Settings2, ShieldCheck, ShieldAlert, Wallet, X } from 'lucide-react';
import type { Amount, DashboardState, Position, Quote, Snapshot, SessionInfo } from '../shared/types';
import './styles.css';
import { IntegrationsPanel } from './integrations';
import { DiscordPanel } from './discord';

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
function number(value: Amount, decimals = 2): string { return value === null ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
function money(value: Amount, currency = 'USD'): string { return value === null ? '—' : `${currency === 'USD' ? '$' : currency + ' '}${number(value)}`; }
function percent(value: Amount): string { return value === null ? '—' : `${number(value * 100, 1)}%`; }
function signed(value: Amount, currency = 'USD'): string { return value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(Math.abs(value), currency)}`; }
function tone(value: Amount): string { return value === null || value === 0 ? '' : value > 0 ? 'positive' : 'negative'; }
function clock(value?: string | null): string { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未采集'; }
function age(value?: string | null): string {
  if (!value) return '未提供';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}
const quoteLabels: Record<string, string> = { REALTIME: '实时源', DELAYED: '延迟源', FROZEN: '冻结', FROZEN_DELAYED: '冻结延迟', REJECT: '无权限', UNKNOWN: '状态未知' };
let csrfToken = '';
let localSession = false;
async function api<T>(url: string, body?: unknown): Promise<T> {
  if (body !== undefined && localSession) await readSession();
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '请求失败');
  return result as T;
}
async function readSession(): Promise<SessionInfo> {
  const session = await api<SessionInfo>('/api/session');
  csrfToken = session.csrf ?? '';
  localSession = session.accessMode === 'local';
  return session;
}
function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><div className="brand-mark">ib<span>.</span></div>{!compact && <div><b>持仓观察台</b><span className="brand-sub">IBKR / READ ONLY</span></div>}</div>;
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const session = await api<{ csrf: string }>('/api/login', { password }); csrfToken = session.csrf; onLogin(); }
    catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="login-shell"><section className="login-art"><Brand /><div className="login-message"><span className="eyebrow">LESS NOISE. MORE CLARITY.</span><h1>看清持仓，<br />而不只是价格。</h1><p>直接连接 IB 官方 MCP，<br />让每一项估值、风险与数据状态都有出处。</p><div className="login-tags"><span><ShieldCheck size={16} />只读授权</span><span><Database size={16} />真实账户</span><span><LockKeyhole size={16} />私密访问</span></div></div><div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" /><small>YOUR PORTFOLIO. YOUR PERSPECTIVE.</small></section><section className="login-panel"><div className="login-form"><span className="eyebrow">PRIVATE WORKSPACE</span><h2>欢迎回来</h2><p>登录你的私人持仓看板</p><form onSubmit={submit}><label htmlFor="password">看板密码</label><input id="password" type="password" autoComplete="current-password" autoFocus value={password} onChange={event => setPassword(event.target.value)} placeholder="输入看板密码，不是 IB 密码" required maxLength={256} /><button className="button primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : '进入看板'}<ArrowUpRight size={18} /></button>{error && <p className="form-error" role="alert">{error}</p>}</form><div className="login-help"><LockKeyhole size={17} /><p>首次使用：在服务器项目目录运行<br /><code>npm run show-login</code><br />取得初始密码，登录后可在设置中修改。</p></div><span className="login-footer">不保存 IB 密码 · 不具备交易权限</span></div></section></main>;
}
function Stat({ label, value, note, icon, accent = false }: { label: string; value: string; note: string; icon: React.ReactNode; accent?: boolean }) {
  return <article className={`stat-card ${accent ? 'accent' : ''}`}><div className="stat-label">{label}{icon}</div><strong>{value}</strong><div className="stat-note">{note}</div></article>;
}
function History({ history, currency }: { history: DashboardState['history']; currency: string }) {
  const selected = history.slice(-180);
  if (selected.length < 2) return <div className="chart-empty"><Activity size={26} /><p>净值轨迹正在积累</p><span>至少两个成功快照后显示，不填充历史数据。</span></div>;
  const minimum = Math.min(...selected.map(point => point.nav));
  const maximum = Math.max(...selected.map(point => point.nav));
  const spread = Math.max(maximum - minimum, Math.abs(maximum) * 0.0002, 0.01);
  const firstTime = Date.parse(selected[0].time);
  const duration = Math.max(1, Date.parse(selected.at(-1)!.time) - firstTime);
  const points = selected.map(point => `${12 + ((Date.parse(point.time) - firstTime) / duration) * 636},${20 + (1 - (point.nav - minimum) / spread) * 100}`).join(' ');
  return <div className="history"><div className="chart-range"><span>{money(maximum, currency)}</span><span>{money(minimum, currency)}</span></div><svg viewBox="0 0 660 150" role="img" aria-label="实际采集净值轨迹，不代表收益率" preserveAspectRatio="none"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#c5ef72" stopOpacity=".25" /><stop offset="100%" stopColor="#c5ef72" stopOpacity="0" /></linearGradient></defs><path d="M 12 30 H 648 M 12 75 H 648 M 12 120 H 648" className="chart-grid" /><polygon points={`12,150 ${points} 648,150`} fill="url(#chart-fill)" /><polyline points={points} fill="none" stroke="#c5ef72" strokeWidth="2.5" vectorEffect="non-scaling-stroke" /></svg><div className="chart-times"><span>{new Date(selected[0].time).toLocaleTimeString('zh-CN')}</span><span>{new Date(selected.at(-1)!.time).toLocaleTimeString('zh-CN')}</span></div></div>;
}
function Allocation({ snapshot }: { snapshot: Snapshot }) {
  const { positions, analysis, account } = snapshot;
  const allocations = [{ kind: 'stock', label: '股票', color: '#c5ef72' }, { kind: 'option', label: '期权', color: '#a6a1ff' }, { kind: 'other', label: '其他', color: '#82c9f3' }].map(category => ({ ...category, value: positions.filter(position => position.kind === category.kind).reduce((total, position) => total + Math.abs(position.value ?? 0), 0) }));
  const total = analysis.grossAbsoluteValue;
  let running = 0;
  const segments = allocations.map(allocation => { const start = running; running += total ? allocation.value / total * 100 : 0; return `${allocation.color} ${start}% ${running}%`; });
  return <section className="panel allocation-panel"><div className="panel-heading"><h2>资产构成</h2><span className="tiny">绝对市值口径</span></div>{total !== null && total > 0 ? <><div className="donut" style={{ background: `conic-gradient(${segments.join(',')})` }}><div><span>持仓绝对市值</span><strong>{money(total, account.currency)}</strong><small>不含现金 · 非 Delta 敞口</small></div></div><div className="allocation-legend">{allocations.filter(allocation => allocation.value > 0).map(allocation => <div key={allocation.kind}><span><i style={{ background: allocation.color }} />{allocation.label}</span><b>{percent(allocation.value / total)}</b><small>{money(allocation.value, account.currency)}</small></div>)}</div></> : <div className="chart-empty">数据缺失或没有持仓，暂无构成图。</div>}</section>;
}
function Concentration({ snapshot }: { snapshot: Snapshot }) {
  const top = [...snapshot.positions].filter(position => position.kind === 'stock' && position.navWeight !== null && position.value !== null && position.value > 0).sort((first, second) => second.value! - first.value!).slice(0, 5);
  return <section className="panel concentration"><div className="panel-heading"><h2>核心持仓</h2><span className="tiny">占账户净值</span></div><div className="concentration-list">{top.map((position, index) => <div className="concentration-row" key={position.id}><span className="rank">0{index + 1}</span><div><div className="bar-label"><b>{position.symbol}</b><span>{percent(position.navWeight)}</span></div><div className="track"><i style={{ width: `${Math.min(100, (position.navWeight ?? 0) * 100)}%`, background: index === 0 ? '#c5ef72' : '#7b866d' }} /></div></div></div>)}{!top.length && <p className="muted">暂无可计算的股票持仓</p>}</div><div className="panel-foot">前三大股票 / 净值 <b>{percent(snapshot.analysis.topThreeWeight)}</b></div></section>;
}
function QuoteCell({ quote }: { quote?: Quote }) {
  if (!quote) return <span className="muted tiny">等待轮询</span>;
  const old = Date.now() - Date.parse(quote.fetchedAt) > 5 * 60000;
  return <div className="quote-cell" title={`报价拉取：${clock(quote.fetchedAt)}\n最近成交时间：${clock(quote.lastTradeAt)}\n最近成交价：${number(quote.last)}${quote.lastIsClose ? '（收盘标记）' : ''}\n买/卖：${number(quote.bid)} / ${number(quote.ask)}\n行情源状态不是本网页的实时流；报价与持仓估值可能不同。`}><b>{number(quote.mark ?? quote.last)} <small>{quote.mark !== null ? '标记价' : '成交价'}</small></b><span className={`quote-status ${quote.status === 'REALTIME' && !old ? 'live' : 'delayed'}`}><i />{quoteLabels[quote.status] ?? quote.status} · {age(quote.fetchedAt)}</span></div>;
}
function Holdings({ snapshot, quotes }: { snapshot: Snapshot; quotes: DashboardState['quotes'] }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: 'value' | 'unrealizedPnl' | 'navWeight'; descending: boolean }>({ key: 'value', descending: true });
  const visible = useMemo(() => snapshot.positions.filter(position => (filter === 'all' || position.kind === filter) && position.description.toLowerCase().includes(query.toLowerCase())).sort((first, second) => {
    const firstValue = first[sort.key]; const secondValue = second[sort.key];
    if (firstValue === null) return 1; if (secondValue === null) return -1;
    return (firstValue - secondValue) * (sort.descending ? -1 : 1);
  }), [snapshot, filter, query, sort]);
  const changeSort = (key: typeof sort.key) => setSort(previous => ({ key, descending: previous.key === key ? !previous.descending : true }));
  return <section className="panel holdings-panel" id="holdings"><div className="holdings-heading"><div><h2>全部持仓 <span className="count">{snapshot.positions.length}</span></h2><p>账户持仓估值与独立行情分开显示</p></div><div className="holdings-tools"><div className="segmented" aria-label="持仓类型">{[['all', '全部'], ['stock', '股票'], ['option', '期权'], ['other', '其他']].map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div><label className="search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索持仓" aria-label="搜索持仓" /></label></div></div><div className="table-scroll"><table><thead><tr><th>标的 / 合约</th><th className="numeric">数量</th><th className="numeric">IB 持仓估价</th><th className="numeric"><button onClick={() => changeSort('value')}>持仓市值 <ChevronDown size={13} /></button></th><th className="numeric"><button onClick={() => changeSort('unrealizedPnl')}>未实现盈亏 <ChevronDown size={13} /></button></th><th className="numeric"><button onClick={() => changeSort('navWeight')}>占净值 <ChevronDown size={13} /></button></th><th className="numeric">独立行情 / 采样年龄</th></tr></thead><tbody>{visible.map(position => <tr key={position.id}><td><div className="instrument"><div className={`instrument-badge ${position.kind}`}>{position.symbol.slice(0, 2)}</div><div><strong>{position.symbol}</strong>{position.option ? <span>{position.option.expiry} · {numberFormat.format(position.option.strike)} {position.option.right === 'P' ? 'PUT' : 'CALL'} <em>×{position.option.multiplier}</em></span> : <span>{position.kind === 'stock' ? '股票' : position.brokerAssetClass ?? '待识别合约'} · {position.currency}</span>}</div>{position.quantity !== null && position.quantity < 0 && <span className="short-tag">SHORT</span>}</div></td><td className="numeric">{position.quantity === null ? '—' : numberFormat.format(position.quantity)}</td><td className="numeric" title="IB 持仓接口返回的估价，不是独立行情标记价">{number(position.price)}<small className="cell-sub">{position.currency}</small></td><td className="numeric strong">{money(position.value, position.currency)}</td><td className={`numeric ${tone(position.unrealizedPnl)}`}>{signed(position.unrealizedPnl, position.currency)}</td><td className="numeric muted">{percent(position.navWeight)}</td><td className="numeric"><QuoteCell quote={quotes[position.id]} /></td></tr>)}</tbody></table>{visible.length === 0 && <div className="table-empty">没有匹配的持仓</div>}</div><div className="table-note"><CircleHelp size={14} />盈亏为 IB 返回的未实现盈亏，不是今日涨跌；空头市值与权重保留负号。独立行情不会重算账户净值。</div></section>;
}
function Risk({ snapshot }: { snapshot: Snapshot }) {
  const { analysis, account } = snapshot;
  const puts = analysis.options.filter(option => option.right === 'P');
  const cashCoverage = analysis.shortPutNotional !== null && analysis.shortPutNotional > 0 && account.cash !== null ? Math.max(0, account.cash) / analysis.shortPutNotional : null;
  const contributors = [...snapshot.positions].filter(position => position.unrealizedPnl !== null && position.currency === account.currency).sort((first, second) => second.unrealizedPnl! - first.unrealizedPnl!);
  const best = contributors[0]; const worst = contributors.at(-1);
  return <section id="risk" className="risk-section"><div className="section-heading"><div><span className="eyebrow">LOOK BEYOND THE BALANCE</span><h2>风险透视</h2></div><span className="readonly"><ShieldCheck size={14} />仅分析，不执行交易</span></div><div className="risk-grid"><article className="panel put-panel"><div className="panel-heading"><h2><ShieldAlert size={17} />卖 Put 现金覆盖</h2><span className="amber-tag">{puts.length} 个合约</span></div><div className="risk-value">{money(analysis.shortPutNotional, account.currency)}</div><p className="muted">全部短 Put 行权价 × 数量 × 合约乘数</p><div className="coverage-track"><i style={{ width: `${Math.min(100, (cashCoverage ?? 0) * 100)}%` }} /></div><div className="coverage-legend"><span>当前现金 <b>{money(account.cash, account.currency)}</b></span><span>覆盖 <b>{percent(cashCoverage)}</b></span></div><div className="risk-callout">不依靠卖出持仓或融资时，现金缺口为 <b>{money(analysis.shortPutCashGap, account.currency)}</b>。这是条件性的行权资金需求，<strong>不是已发生亏损或保证金要求</strong>。</div></article><article className="panel"><div className="panel-heading"><h2>盈亏由什么构成</h2><span className="tiny">未实现 / {account.currency}</span></div><div className="pnl-breakdown"><div><span><i className="legend-dot stock-dot" />股票持仓</span><strong className={tone(analysis.stockPnl)}>{signed(analysis.stockPnl, account.currency)}</strong></div><div><span><i className="legend-dot option-dot" />期权持仓</span><strong className={tone(analysis.optionPnl)}>{signed(analysis.optionPnl, account.currency)}</strong></div></div><div className="contributor"><ArrowUpRight size={17} /><div><span>最高盈亏贡献</span><b>{best?.symbol ?? '—'}{best?.option ? ` ${best.option.right === 'P' ? 'PUT' : 'CALL'}` : ''}</b></div><strong className={tone(best?.unrealizedPnl ?? null)}>{signed(best?.unrealizedPnl ?? null, account.currency)}</strong></div><div className="contributor"><ArrowDownLeft size={17} /><div><span>最低盈亏贡献</span><b>{worst?.symbol ?? '—'}</b></div><strong className={tone(worst?.unrealizedPnl ?? null)}>{signed(worst?.unrealizedPnl ?? null, account.currency)}</strong></div><p className="micro-note">单个盈利头寸可能掩盖其余持仓的亏损；这里不把未实现盈亏换算成账户收益率。</p></article></div><article className="panel option-panel"><div className="panel-heading"><h2>空头期权 · 到期与交割</h2><span className="tiny">按到期日排列</span></div><div className="table-scroll"><table><thead><tr><th>标的</th><th>到期日</th><th>方向</th><th className="numeric">执行价</th><th className="numeric">张数 / 乘数</th><th className="numeric">行权金额</th><th>股票数量匹配</th></tr></thead><tbody>{analysis.options.map(option => <tr key={option.id}><td><b>{option.underlying}</b></td><td>{option.expiry}</td><td><span className={`option-pill ${option.right === 'P' ? 'put' : 'call'}`}>卖 {option.right === 'P' ? 'PUT' : 'CALL'}</span></td><td className="numeric">{money(option.strike, option.currency)}</td><td className="numeric">{option.contracts} × {option.multiplier}</td><td className="numeric">{money(option.strikeNotional, option.currency)}</td><td>{option.right === 'C' ? <span className={option.unmatchedShares === 0 ? 'positive' : 'amber'}>{option.matchedShares === null ? '数量缺失，待核实' : `${option.matchedShares}/${option.shares} 股可匹配${option.unmatchedShares ? ' · 存在缺口' : ''}`}</span> : <span className="muted">行权买入 {option.shares} 股</span>}</td></tr>)}</tbody></table>{!analysis.options.length && <div className="table-empty">没有识别到空头期权</div>}</div><div className="table-note">合约条款来自 IB 描述；调整合约须核实交割资产。股票匹配不计入已挂卖单、其他策略占用，也不代表券商认定的备兑。</div></article></section>;
}
function Settings({ close, logout }: { close: () => void; logout: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/api/password', { currentPassword, password }); logout(); }
    catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={close}><section className="modal panel" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()}><div className="panel-heading"><h2 id="settings-title">安全设置</h2><button className="icon-button" onClick={close} aria-label="关闭设置"><X size={19} /></button></div><p className="muted">修改密码后，所有已登录会话都会失效。</p><form onSubmit={submit}><label htmlFor="old-password">当前密码</label><input id="old-password" type="password" autoFocus autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required /><label htmlFor="new-password">新密码 · 至少 12 个字符</label><input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} required /><button className="button primary full" disabled={busy}>更新密码<Check size={17} /></button>{error && <p className="form-error">{error}</p>}</form></section></div>;
}
function Dashboard({ logout, localAccess }: { logout: () => void; localAccess: boolean }) {
  const [state, setState] = useState<DashboardState | null>(null);
  const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState(false);
  const [integrations, setIntegrations] = useState(false);
  const [discord, setDiscord] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [, updateClock] = useState(0);
  useEffect(() => {
    let active = true;
    api<DashboardState>('/api/portfolio').then(value => { if (active) setState(value); }).catch(problem => { if (active) setNotice(problem.message); });
    const events = new EventSource('/api/events');
    events.onmessage = event => { setState(JSON.parse(event.data)); setConnected(true); };
    events.onerror = () => setConnected(false);
    events.addEventListener('expired', logout);
    const timer = window.setInterval(() => updateClock(value => value + 1), 10000);
    const connection = new URLSearchParams(window.location.search).get('connection');
    if (connection) { setNotice(connection === 'success' ? 'IB 只读授权已连接。' : 'IB 授权未完成，请重新连接；如有地区限制，请检查 IB 官方可用范围。'); window.history.replaceState(null, '', '/'); }
    return () => { active = false; events.close(); window.clearInterval(timer); };
  }, []);
  async function refresh() { try { await api('/api/refresh', {}); setNotice(''); } catch (problem) { setNotice((problem as Error).message); } }
  async function connect() {
    if (state?.status.connected && !window.confirm('重新授权会替换本看板当前的 IB 连接。继续吗？')) return;
    setConnecting(true);
    try { const result = await api<{ url: string }>('/api/ibkr/connect', {}); window.location.assign(result.url); }
    catch (problem) { setNotice((problem as Error).message); setConnecting(false); }
  }
  async function signOut() { try { await api('/api/logout', {}); logout(); } catch (problem) { setNotice((problem as Error).message); } }
  const snapshot = state?.snapshot;
  const stale = !snapshot || Date.now() - Math.min(...Object.values(snapshot.sources).map(value => Date.parse(value))) > (state?.status.staleSeconds ?? 180) * 1000;
  const busy = Boolean(state?.status.refreshing);
  return <div className="app-shell"><aside className="sidebar"><Brand compact /><nav><a className="nav-icon selected" href="#overview" aria-label="总览" title="总览"><LayoutDashboard size={21} /></a><a className="nav-icon" href="#holdings" aria-label="持仓" title="持仓"><Wallet size={21} /></a><a className="nav-icon" href="#risk" aria-label="风险" title="风险"><ShieldAlert size={21} /></a></nav><div className="sidebar-bottom"><button className="nav-icon" onClick={() => setDiscord(true)} aria-label="Discord 动态状态" title="Discord 动态状态"><Activity size={20} /></button><button className="nav-icon" onClick={() => setIntegrations(true)} aria-label="飞书与模型" title="飞书与模型"><Radio size={20} /></button>{!localAccess && <><button className="nav-icon" onClick={() => setSettings(true)} aria-label="安全设置" title="安全设置"><Settings2 size={20} /></button><button className="nav-icon" onClick={signOut} aria-label="退出登录" title="退出登录"><LogOut size={20} /></button></>}{localAccess && <span className="nav-icon" title="本机免密访问"><ShieldCheck size={20} /></span>}<div className="user-avatar">P</div></div></aside><div className="workspace"><header className="topbar"><div className="breadcrumb">私人工作区<ChevronRight size={13} /><b>持仓总览</b></div><div className="topbar-right">{localAccess && <span className="readonly">本机免密</span>}<span className="connection"><i className={connected ? 'dot green' : 'dot amber-bg'} />{connected ? '看板连接正常' : '看板重连中'}</span><span className="readonly"><ShieldCheck size={14} />MCP.READ</span></div></header><main className="dashboard" id="overview"><div className="page-heading"><div><span className="eyebrow">PORTFOLIO OBSERVATORY</span><h1>持仓总览<span className="title-dot">.</span></h1><p>你的资产全貌，更清晰一点。</p></div><div className="heading-actions"><span className="date-label">{new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}</span><button className="button secondary" onClick={connect} disabled={connecting}>{connecting ? <LoaderCircle className="spin" size={15} /> : <ExternalLink size={15} />}{state?.status.connected ? 'IB 授权' : '连接 IB'}</button><button className="button primary" onClick={refresh} disabled={busy || !state?.status.connected}><RefreshCw size={15} className={busy ? 'spin' : ''} />{busy ? '采集中' : '刷新数据'}</button></div></div>{notice && <div className="notice" role="alert"><CircleHelp size={17} /><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}{state?.status.error && <div className="notice warning"><ShieldAlert size={17} /><span>{state.status.error}</span></div>}<div className="freshness"><div><span className={`status-pill ${stale ? 'warning' : ''}`}><Radio size={13} />{stale ? '快照待更新' : 'IB 快照已采集'}</span><span>账户拉取 {age(snapshot?.fetchedAt)}</span><span className="freshness-divider" /><span>每轮完成后 {state?.status.pollSeconds ?? 60}s 再采集</span></div><span title={snapshot ? `持仓：${clock(snapshot.sources.positions)}\n摘要：${clock(snapshot.sources.summary)}\n余额：${clock(snapshot.sources.balances)}` : ''}><Clock3 size={13} />{clock(snapshot?.fetchedAt)}</span></div>{snapshot && state ? <><section className="stats-grid"><Stat label={`账户净值 / ${snapshot.account.currency}`} value={money(snapshot.account.nav, snapshot.account.currency)} note="IB 净清算价值 · 非实时重估" icon={<Wallet size={17} />} accent /><Stat label="未实现盈亏" value={signed(snapshot.account.unrealizedPnl, snapshot.account.currency)} note="IB 余额口径 · 不是当日收益" icon={<Activity size={17} />} /><Stat label="现金余额" value={money(snapshot.account.cash, snapshot.account.currency)} note={`占净值 ${percent(snapshot.analysis.cashRatio)} · 非购买力`} icon={<Database size={17} />} /><Stat label="剩余流动性" value={money(snapshot.account.excessLiquidity, snapshot.account.currency)} note={`IB Excess Liquidity · 维持保证金 ${money(snapshot.account.maintenanceMargin, snapshot.account.currency)}`} icon={<ShieldCheck size={17} />} /></section><div className="overview-grid"><section className="panel nav-panel"><div className="panel-heading"><div><h2>净值观察</h2><p>仅本服务实际采集的快照</p></div><span className="badge neutral">非收益率曲线</span></div><History history={state.history} currency={snapshot.account.currency} /><div className="nav-metrics"><div><span>持仓净市值</span><b>{money(snapshot.analysis.netPositionValue, snapshot.account.currency)}</b></div><div><span>IB 杠杆</span><b>{snapshot.account.leverage === null ? '—' : `${number(snapshot.account.leverage)}×`}</b></div><div><span>初始保证金</span><b>{money(snapshot.account.initialMargin, snapshot.account.currency)}</b></div></div></section><Allocation snapshot={snapshot} /><Concentration snapshot={snapshot} /></div><Holdings snapshot={snapshot} quotes={state.quotes} /><Risk snapshot={snapshot} /><section className="methodology panel"><div className="panel-heading"><h2><CircleHelp size={17} />数据口径与边界</h2><span className="tiny">透明比精确的假象更重要</span></div><div className="methodology-grid"><div><h3>01 / 来源与实时性</h3><p>全部来自 IB 官方 MCP。账户轮询不是行情推流；每轮最多采样 {state.status.quoteBatchSize} 个 USD 股票 / 股票期权，逐轮覆盖。每行独立标注源状态与采样年龄，缺失字段保留为空。</p>{state.status.quoteError && <p className="amber">{state.status.quoteError}</p>}</div><div><h3>02 / 净值与持仓</h3><p>净值 − 现金 − 持仓净市值 = <b>{money(snapshot.analysis.residual, snapshot.account.currency)}</b>。IB 应计股息：<b>{money(snapshot.account.dividends, snapshot.account.currency)}</b>。两者展示但不自动认定相等；不重复加总 BASE 与币种行。</p></div><div><h3>03 / 不可推断的内容</h3><p>没有用持仓盈亏推导今日收益，没有伪造历史，没有计算缺少 Greeks 的 Delta 风险，也没有把购买力视作现金。</p></div></div><details><summary>查看完整限制说明</summary><ul>{snapshot.analysis.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details></section></> : <section className="empty-state panel"><div className="empty-icon"><Database size={28} /></div><h2>{busy ? '正在读取你的真实持仓' : '从连接 IB 开始'}</h2><p>使用 mcp.read 授权，只能读取数据。<br />首次采集完成后展示持仓，不使用演示数据。</p>{!state?.status.connected && <button className="button primary" onClick={connect} disabled={connecting}>连接 IB 只读授权<ArrowUpRight size={16} /></button>}</section>}<footer><span><span className="footer-logo">ib.</span> 持仓观察台</span><span>数据：Interactive Brokers MCP · 仅供持仓观察，不构成交易建议</span><span><LockKeyhole size={12} />PRIVATE & READ ONLY</span></footer></main></div>{discord && <DiscordPanel close={() => setDiscord(false)} />}{integrations && <IntegrationsPanel close={() => setIntegrations(false)} />}{settings && !localAccess && <Settings close={() => setSettings(false)} logout={logout} />}</div>;
}
function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [localAccess, setLocalAccess] = useState(false);
  const [startupError, setStartupError] = useState('');
  async function restoreSession() {
    try {
      const session = await readSession();
      setLocalAccess(session.accessMode === 'local');
      setAuthenticated(session.authenticated);
      setStartupError('');
    } catch { setStartupError('无法连接看板服务，请确认服务运行后刷新页面。'); }
  }
  useEffect(() => { void restoreSession(); }, []);
  if (startupError) return <div className="boot-screen"><ShieldAlert size={28} /><p>{startupError}</p><button className="button primary" onClick={() => window.location.reload()}>重试</button></div>;
  if (authenticated === null) return <div className="boot-screen"><Brand /><LoaderCircle className="spin" size={24} /></div>;
  return authenticated ? <Dashboard localAccess={localAccess} logout={() => { if (localAccess) void restoreSession(); else { csrfToken = ''; setAuthenticated(false); } }} /> : <Login onLogin={() => setAuthenticated(true)} />;
}
createRoot(document.getElementById('root')!).render(<App />);
