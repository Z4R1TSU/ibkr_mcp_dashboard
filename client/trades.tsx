import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { tradeClock, tradeDate, tradeType, TRADE_RANGES, type TradeRange, type Trade, type TradesState } from '../shared/trades';
import './trades.css';

type Request = <T>(url: string, body?: unknown) => Promise<T>;
const format = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });
const number = (value: number | null) => value === null ? '—' : format.format(value);
const classes: Record<string, string> = { STK: '股票', OPT: '期权', CASH: '换汇', FUT: '期货', FOP: '期货期权' };

export function Trades({ request }: { request: Request }) {
  const [result, setData] = useState<TradesState | null>(null);
  const [range, setRange] = useState<TradeRange>('previous');
  const data = result?.range === range ? result : null;
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      let delay = 15000;
      try {
        const next = await request<TradesState>('/api/trades?range=' + range);
        if (!active) return;
        setData(next); setError('');
        delay = next.refreshing ? 2000 : 60000;
      } catch (problem) { if (active) setError((problem as Error).message); }
      if (active) timer = setTimeout(() => void load(), delay);
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [request, revision, range]);
  async function refresh() {
    setBusy(true);
    try {
      setData(await request<TradesState>('/api/trades/refresh?range=' + range, {}));
      setError(''); setRevision(value => value + 1);
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }
  const visible = useMemo(() => (data?.trades ?? []).filter(t =>
    [t.symbol, t.name, tradeType(t), t.contractDescription].some(value => value?.toLowerCase().includes(query.trim().toLowerCase())) || !query.trim()), [data, query]);
  const pages = Math.max(1, Math.ceil(visible.length / 20));
  const currentPage = Math.min(page, pages - 1);
  const groups = new Map<string, Trade[]>();
  for (const trade of visible.slice(currentPage * 20, (currentPage + 1) * 20)) {
    const date = tradeDate(trade.time);
    groups.set(date, [...(groups.get(date) ?? []), trade]);
  }
  const loading = busy || Boolean(data?.refreshing) || !data && !error;
  const warning = error || data?.error || (data?.stale && data.fetchedAt ? '成交记录待更新，当前显示上次成功查询。' : '');
  return <section className="panel holdings-panel trades-panel" id="trades" aria-busy={loading}>
    <div className="holdings-heading">
      <div><h2>交易记录 <span className="count">{data?.fetchedAt ? data.trades.length : '—'}</span></h2><p>{data ? data.startDate === data.endDate ? data.startDate : `${data.startDate} — ${data.endDate}` : TRADE_RANGES[range]} · 美东时间 · 最新成交在前</p></div>
      <div className="holdings-tools">
        <label className="search"><Search size={15} /><input value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="搜索标的" aria-label="搜索成交标的" /></label>
        <button className="button secondary" onClick={refresh} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} />{loading ? '读取成交中' : '刷新成交'}</button>
      </div>
    </div>
    <div className="trades-range-row"><div className="segmented trades-ranges" role="group" aria-label="交易时间范围">
      {(Object.entries(TRADE_RANGES) as [TradeRange, string][]).map(([value, label]) =>
        <button key={value} className={range === value ? 'active' : ''} aria-pressed={range === value}
          onClick={() => { setRange(value); setPage(0); setError(''); }}>{label}</button>)}
    </div></div>
    {warning && <p className="trades-warning" role="status">{warning}</p>}
    <div className="table-scroll"><table aria-label="美东时间近期成交">
      <thead><tr><th>成交时间 / 美东</th><th>标的 / 合约</th><th>交易类型</th><th className="numeric">数量</th><th className="numeric">成交价</th><th className="numeric">净额</th><th className="numeric">手续费</th></tr></thead>
      {[...groups].map(([date, trades]) => <tbody key={date}>
        <tr className="trade-date"><th colSpan={7} scope="rowgroup">{date} <span>美东</span></th></tr>
        {trades.map(trade => <TradeRow key={trade.id} trade={trade} />)}
      </tbody>)}
    </table>{!visible.length && <div className="table-empty">{loading && !data?.fetchedAt ? '正在读取成交记录…' : !data?.fetchedAt ? '暂时无法取得成交记录，请稍后刷新。' : query.trim() ? '没有匹配的成交' : '所选范围暂无成交记录'}</div>}</div>
    <div className="trades-footer">
      <span>{data?.fetchedAt ? `查询时间：${tradeDate(data.fetchedAt)} ${tradeClock(data.fetchedAt)}` : '尚无成功查询'} · 自动切换夏令时</span>
      {pages > 1 && <div className="trades-pages">
        <button className="icon-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="上一页成交"><ChevronLeft size={17} /></button>
        <span>{currentPage + 1} / {pages} · {visible.length} 笔</span>
        <button className="icon-button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)} aria-label="下一页成交"><ChevronRight size={17} /></button>
      </div>}
    </div>
    <div className="table-note">净额采用 IB 返回值；手续费币种未提供。部分历史期权缺少 Put/Call 信息，明确标为待确认；你提供的类型会注明确认来源。</div>
  </section>;
}

function TradeRow({ trade }: { trade: Trade }) {
  const kind = trade.assetClass === 'STK' ? 'stock' : trade.assetClass === 'OPT' ? 'option' : 'other';
  const buy = trade.side === 'BUY', sell = trade.side === 'SELL';
  const source = !['OPT', 'FOP'].includes(trade.assetClass ?? '') ? undefined : trade.optionSource === 'user' ? '类型由你确认' : trade.optionSource === 'order' ? '类型来自同一订单的合约描述' : trade.optionSource === 'trade' ? '类型来自成交合约字段' : 'IB 未返回 Put/Call 信息';
  return <tr>
    <td className="trade-time"><time dateTime={trade.time} title={tradeDate(trade.time) + ' ' + tradeClock(trade.time)}>{tradeClock(trade.time)}</time></td>
    <td><div className="instrument"><div className={`instrument-badge ${kind}`}>{trade.symbol?.slice(0, 2) ?? '—'}</div><div>
      <strong>{trade.symbol ?? '未知标的'}</strong><span>{trade.optionRight === 'P' ? '看跌期权 · Put' : trade.optionRight === 'C' ? '看涨期权 · Call' : classes[trade.assetClass ?? ''] ?? trade.assetClass ?? '类型未知'}</span>
      {(trade.contractDescription || trade.name) && <span className="trade-name" title={trade.contractDescription ?? trade.name ?? undefined}>{trade.contractDescription ?? trade.name}</span>}{trade.optionSource === 'user' && <span className="trade-type-source">类型：你已确认</span>}
    </div></div></td>
    <td><span title={source} className={`trade-side ${buy ? 'buy' : sell ? 'sell' : ''}`}>{buy ? <ArrowDownLeft size={13} /> : sell ? <ArrowUpRight size={13} /> : null}{tradeType(trade)}</span></td>
    <td className="numeric">{number(trade.size)}</td>
    <td className="numeric">{number(trade.price)}<small className="cell-sub">{trade.currency ?? '币种未知'}</small></td>
    <td className="numeric">{number(trade.netAmount)}<small className="cell-sub">{trade.currency ?? '币种未知'}</small></td>
    <td className="numeric" title="IB 未提供手续费币种">{number(trade.commission)}</td>
  </tr>;
}
