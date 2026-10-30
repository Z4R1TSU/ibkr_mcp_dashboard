import React, { useEffect, useState } from 'react';
import { Banknote, ChevronDown, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { cashFlowLabel, cashFlowMoney, type CashFlowsState } from '../shared/cash-flows';
import { tradeClock } from '../shared/trades';
import './cash-flows.css';

type Request = <T>(url: string, body?: unknown) => Promise<T>;

type CashFlowProps = { request: Request; onUpdated: (value: string | null) => void };

export function CashFlows({ request, onUpdated, expanded, onToggle }: CashFlowProps & { expanded: boolean; onToggle: () => void }) {
  return <section className="panel holdings-panel cash-flows-panel" id="cash-flows" aria-labelledby="cash-flows-title">
    <button className="cash-flow-toggle" aria-expanded={expanded} aria-controls="cash-flow-content" onClick={onToggle}>
      <span className="cash-flow-toggle-title"><Banknote size={18} /><span><b id="cash-flows-title">入金记录</b><small>换汇推算 · 入出金参考与平均汇率</small></span></span>
      <span className="cash-flow-toggle-action">{expanded ? '收起' : '展开'}<ChevronDown size={17} /></span>
    </button>
    <div id="cash-flow-content" hidden={!expanded}>{expanded && <CashFlowContents request={request} onUpdated={onUpdated} />}</div>
  </section>;
}

function CashFlowContents({ request, onUpdated }: CashFlowProps) {
  const [data, setData] = useState<CashFlowsState | null>(null);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      let delay = 15000;
      try {
        const next = await request<CashFlowsState>('/api/cash-flows');
        if (!active) return;
        setData(next); setError(''); onUpdated(next.fetchedAt);
        delay = next.refreshing ? 2000 : 60000;
      } catch (problem) { if (active) setError((problem as Error).message); }
      if (active) timer = setTimeout(() => void load(), delay);
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [request, revision, onUpdated]);
  async function refresh() {
    setBusy(true);
    try {
      const next = await request<CashFlowsState>('/api/cash-flows/refresh', {});
      setData(next); setError(''); onUpdated(next.fetchedAt); setRevision(value => value + 1);
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }
  const rows = (data?.records ?? []).filter(row => filter === 'all' || row.direction === filter);
  const pages = Math.max(1, Math.ceil(rows.length / 15)), current = Math.min(page, pages - 1);
  const loading = busy || Boolean(data?.refreshing) || !data && !error;
  const known = Boolean(data?.fetchedAt || data?.records.length);
  const warning = error || data?.error || (data?.stale && known ? '换汇记录待更新，当前保留已保存记录。' : '');
  return <div className="cash-flow-content" aria-busy={loading}>
    <div className="holdings-heading">
      <div><span className="badge neutral">换汇推算</span>
        <p>含出金参考 · 美东时间 · {data ? data.startDate + ' — ' + data.endDate : '本年换汇及已保存历史'}</p></div>
      <button className="button secondary" onClick={refresh} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} />{loading ? '读取换汇中' : '刷新换汇'}</button>
    </div>
    <div className="cash-flow-summary" aria-live="polite">
      {([['deposits', '入金参考', '换入美元'], ['withdrawals', '出金参考', '换出美元'], ['net', '净入金参考', '换入减换出']] as const).map(([key, label, note]) =>
        <div key={key}><span>{label} / USD</span><strong>{known ? cashFlowMoney(data!.totals[key]) : '—'}</strong><small>{note}</small></div>)}
    </div>
    <section className="cash-flow-rates" aria-label="平均换汇汇率">
      <h3>平均换汇汇率 <small>按美元金额加权 · 原币 / USD</small></h3>
      {!!data?.exchangeRates?.length ? <div className="cash-flow-rate-grid">
        {data.exchangeRates.map(rate => <div className="cash-flow-rate" key={rate.currency}>
          <b>{rate.currency} / USD</b>
          <dl>{([['depositRate', '换入美元均价'], ['withdrawalRate', '换出美元均价']] as const).map(([key, label]) =>
            <div key={key}><dt>{label}</dt><dd title={rate[key] === null ? '暂无该方向的换汇' : String(rate[key])}>
              {rate[key] === null ? '—' : rate[key].toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
            </dd></div>)}</dl>
        </div>)}
      </div> : <p>{known ? '暂无可计算的换汇记录' : '等待换汇记录'}</p>}
      <p>均价 = 对应原币金额合计 ÷ 美元金额合计；换入、换出分开统计，未计手续费。</p>
    </section>
    {warning && <p className="cash-flow-notice" role="status">{warning}</p>}
    {!!data?.skipped && <p className="cash-flow-notice">{data.skipped} 笔非美元换汇或字段不完整的记录未计入推算。</p>}
    <div className="cash-flow-filters"><div className="segmented" role="group" aria-label="入出金方向">
      {[['all', '全部'], ['deposit', '入金'], ['withdrawal', '出金']].map(([value, label]) =>
        <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(0); }}>{label}</button>)}
    </div><span>{rows.length} 笔 · 含零碎余额转换</span></div>
    <div className="table-scroll"><table aria-label="按换汇推算的入出金记录">
      <thead><tr><th>换汇时间 / 美东</th><th>方向</th><th className="numeric">金额 / USD</th><th className="numeric">对应原币金额</th><th>原始换汇</th><th className="numeric">成交汇率</th></tr></thead>
      <tbody>{rows.slice(current * 15, (current + 1) * 15).map(row => <tr key={row.id}>
        <td><time dateTime={row.time}>{row.date}<small>{tradeClock(row.time)}</small></time></td>
        <td><span className={'cash-flow-' + row.direction}>{cashFlowLabel(row.direction)}（推算）</span></td>
        <td className="numeric">{row.direction === 'deposit' ? '+' : '−'}{cashFlowMoney(row.amount)}</td>
        <td className="numeric">{cashFlowMoney(row.counterAmount)} {row.counterCurrency}</td>
        <td>{row.symbol}<small>{row.side === 'BUY' ? '买入' : '卖出'} · 手续费 {row.commission === null ? '未提供' : cashFlowMoney(row.commission) + '（币种未提供）'}</small></td>
        <td className="numeric">{cashFlowMoney(row.price)}</td>
      </tr>)}</tbody>
    </table>{!rows.length && <div className="table-empty">{!known
      ? loading ? '正在读取换汇记录…' : '暂时无法取得换汇记录，请刷新重试。'
      : filter === 'all' ? '所选范围暂无可推算入出金的美元换汇记录' : '暂无该方向的换汇记录'}</div>}</div>
    <div className="cash-flow-footer"><span>{data?.fetchedAt ? '本年换汇更新于 ' + new Date(data.fetchedAt).toLocaleString('zh-CN', { hour12: false }) : '等待本年换汇更新'}</span>
      {pages > 1 && <div><button className="icon-button" aria-label="上一页入出金" disabled={current === 0} onClick={() => setPage(current - 1)}><ChevronLeft size={16} /></button>
        <span>{current + 1} / {pages}</span><button className="icon-button" aria-label="下一页入出金" disabled={current === pages - 1} onClick={() => setPage(current + 1)}><ChevronRight size={16} /></button></div>}
    </div>
    <div className="table-note">按美元换入、换出方向推算，非实际银行入出金；同日双向换汇相抵计算净额，未扣除币种不明的手续费。日历按换汇发生日展示，推算金额不计入盈亏。</div>
  </div>;
}
