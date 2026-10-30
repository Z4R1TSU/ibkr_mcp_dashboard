import React, { useEffect, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock3, RefreshCw } from 'lucide-react';
import { calendarDates, PNL_TIME_ZONE, shiftCalendarMonth, type PnlCalendar as CalendarData, type PnlCalendarDay } from '../shared/pnl-calendar';
import './pnl-calendar.css';
import { cashFlowLabel, cashFlowMoney, cashFlowTotals } from '../shared/cash-flows';

type Request = <T>(url: string, body?: unknown) => Promise<T>;
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
const number = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sign = (value: number) => value > 0 ? '+' : value < 0 ? '−' : '';
const signed = (value: number | null, suffix = '') => value === null ? '—' : sign(value) + number(Math.abs(value)) + suffix;
const tone = (value: number | null) => value === null || value === 0 ? '' : value > 0 ? 'pnl-profit' : 'pnl-loss';
const monthLabel = (value: string) => value.slice(0, 4) + ' 年 ' + Number(value.slice(5)) + ' 月';
const clock = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: PNL_TIME_ZONE, hour12: false });
const compactFlow = (value: number) => value < 0.01 ? '<0.01' : value.toLocaleString('en-US',
  { notation: value >= 1000 ? 'compact' : 'standard', maximumFractionDigits: value >= 1000 ? 1 : 2 });

function DayDetails({ day, today, currency, loading }: { day?: PnlCalendarDay; today: string; currency: string; loading: boolean }) {
  const money = (value: number | null) => value === null ? '—' : number(value);
  return <aside className="pnl-detail" aria-live="polite" aria-label="单日盈亏详情">
    <span className="pnl-detail-eyebrow">单日详情</span>
    {day ? <>
      <div className="pnl-detail-date"><h3>{Number(day.date.slice(5, 7))} 月 {Number(day.date.slice(-2))} 日</h3>
        <span>{dayLabel(day, today)}</span></div>
      <p>{day.date.slice(0, 4)} · 星期{weekdays[new Date(day.date + 'T00:00:00Z').getUTCDay()]} · 美东</p>
      <div className="pnl-detail-amount"><span>当日盈亏 / {currency}</span><strong className={tone(day.pnl)}>{signed(day.pnl)}</strong></div>
      <dl>
        <div><dt>记录来源</dt><dd>{day.source === 'local-snapshot' ? '本地封板记录' : day.source === 'daily-report' ? '本地日报' : day.source === 'ib-pa' ? 'IB 历史补充' : '—'}</dd></div>
        <div><dt>当日收益率</dt><dd className={tone(day.returnPct)}>{signed(day.returnPct, '%')}</dd></div>
        <div><dt>{day.issue === 'date-gap' ? '区间起始净值' : '前日净值'}</dt><dd>{money(day.startNav)}</dd></div>
        <div><dt>当日净值</dt><dd>{money(day.endNav)}</dd></div>
        {day.issue && <div><dt>净值变动</dt><dd>{signed(day.navChange)}</dd></div>}
      </dl>
      {!!day.cashFlows?.length && <section className="pnl-detail-flows" aria-label="当日入出金参考">
        <h4>当日入出金 <span>换汇推算 · USD</span></h4>
        {day.cashFlows.map(flow => <div key={flow.id}>
          <span className={'cash-flow-' + flow.direction}>{cashFlowLabel(flow.direction)} {flow.direction === 'deposit' ? '+' : '−'}{cashFlowMoney(flow.amount)} USD</span>
          <small>{flow.direction === 'deposit' ? flow.counterCurrency + ' → USD' : 'USD → ' + flow.counterCurrency} · {cashFlowMoney(flow.counterAmount)} {flow.counterCurrency}</small>
        </div>)}
        <p>按换汇发生日推算，非银行入账日期；不计入当日盈亏。</p>
      </section>}
      {day.issue === 'cash-flow' && <p className="pnl-detail-note">净值变动与收益率不一致，可能含入出金。保留 IB 收益率，盈亏金额待确认。{day.cashFlows?.length ? '换汇推算不能直接用于扣减净值差。' : ''}</p>}
      {day.issue === 'date-gap' && <p className="pnl-detail-note">前序数据停留在 {day.previousDate}，无法拆分出单日收益。</p>}
      {day.status === 'missing' && <p className="pnl-detail-note">{day.date === today ? 'IB 尚未提供今日业绩，稍后自动更新。' : '该日没有已保存的业绩数据，不计为零盈亏。'}</p>}
      {day.status === 'closed' && <p className="pnl-detail-note">美股休市日，不计入交易日汇总。</p>}
      {day.provisional && <p className="pnl-detail-note">当前为暂估数据，以 IB 后续更新为准。</p>}
      {day.asOf && <div className="pnl-detail-updated"><Clock3 size={12} /><span>采集于 {clock(day.asOf)} 美东</span></div>}
    </> : <p className="pnl-detail-placeholder">{loading ? '正在读取每日业绩…' : '选择日期查看盈亏详情'}</p>}
  </aside>;
}

function dayLabel(day: PnlCalendarDay, today: string) {
  if (day.status === 'closed') return '休市';
  if (day.status === 'future') return '未到日期';
  if (day.status === 'missing') return day.date === today ? '待更新' : '无数据';
  if (day.issue === 'date-gap') return '区间缺失';
  if (day.issue === 'cash-flow') return '金额待确认';
  return day.provisional ? day.date === today ? '暂估' : '待确认' : '已记录';
}

export function PnlCalendar({ request, expanded, onToggle, cashFlowVersion }: { request: Request; expanded: boolean; onToggle: () => void; cashFlowVersion?: string | null }) {
  return <section className="panel pnl-calendar" id="pnl-calendar" aria-labelledby="pnl-title">
    <button className="pnl-toggle" aria-expanded={expanded} aria-controls="pnl-calendar-content" onClick={onToggle}>
      <span className="pnl-toggle-title"><CalendarDays size={18} /><span><b id="pnl-title">盈亏日历</b><small>按月查看每日盈亏与收益率</small></span></span>
      <span className="pnl-toggle-action">{expanded ? '收起' : '展开'}<ChevronDown size={17} /></span>
    </button>
    <div id="pnl-calendar-content" hidden={!expanded}>{expanded && <CalendarContents request={request} cashFlowVersion={cashFlowVersion} />}</div>
  </section>;
}

function CalendarContents({ request, cashFlowVersion }: { request: Request; cashFlowVersion?: string | null }) {
  const [result, setResult] = useState<CalendarData | null>(null);
  const [month, setMonth] = useState('');
  const [selection, setSelection] = useState('');
  const [mode, setMode] = useState<'amount' | 'return'>('amount');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: PNL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const currentMonth = localToday.slice(0, 7);
  const shownMonth = month || currentMonth;
  const data = result?.month === shownMonth ? result : null;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      let delay = 15000;
      try {
        const next = await request<CalendarData>('/api/pnl-calendar' + (month ? '?month=' + month : ''));
        if (!active) return;
        setResult(next); setError('');
        delay = next.refreshing || next.cashFlows?.refreshing ? 3000 : 60000;
      } catch (problem) { if (active) setError((problem as Error).message); }
      if (active) timer = setTimeout(() => void load(), delay);
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [request, month, revision, cashFlowVersion]);
  function chooseMonth(value: string) { setMonth(value === currentMonth ? '' : value); setSelection(''); setError(''); }
  const firstMonth = result?.earliestDate?.slice(0, 7) ?? currentMonth;
  const months: string[] = [];
  for (let cursor = currentMonth; cursor >= firstMonth; cursor = shiftCalendarMonth(cursor, -1)) months.push(cursor);
  const dates = calendarDates(shownMonth);
  const offset = new Date(dates[0] + 'T00:00:00Z').getUTCDay();
  const cells = [...Array<string | null>(offset).fill(null), ...dates];
  while (cells.length % 7) cells.push(null);
  const selected = data?.days.find(day => day.date === selection)
    ?? data?.days.slice().reverse().find(day => day.status === 'available' || day.cashFlows?.length)
    ?? data?.days.find(day => day.date === data.today)
    ?? data?.days.find(day => day.status === 'missing');
  const summary = data?.summary;
  const completeAmounts = summary && summary.amountDays === summary.expectedDays;
  const loading = !data && !error;
  return <div className="pnl-content" aria-busy={loading}>
    <div className="pnl-heading">
      <p className="pnl-currency">美东交易日 · {data?.currency ?? '账户本位币'}</p>
      <div className="pnl-controls">
        <div className="pnl-month-controls">
          <button className="icon-button" disabled={shownMonth <= firstMonth} onClick={() => chooseMonth(shiftCalendarMonth(shownMonth, -1))} aria-label="上个月"><ChevronLeft size={18} /></button>
          <label className="pnl-month-select"><select aria-label="日历月份" value={shownMonth} onChange={event => chooseMonth(event.target.value)}>
            {months.map(value => <option value={value} key={value}>{monthLabel(value)}</option>)}
          </select><ChevronDown size={13} /></label>
          <button className="icon-button" disabled={shownMonth >= currentMonth} onClick={() => chooseMonth(shiftCalendarMonth(shownMonth, 1))} aria-label="下个月"><ChevronRight size={18} /></button>
        </div>
        <button className="pnl-current" disabled={shownMonth === currentMonth} onClick={() => chooseMonth(currentMonth)}>本月</button>
      </div>
    </div>
    <div className="pnl-summary" aria-live="polite">
      <div className="pnl-total"><span>{completeAmounts ? '月度盈亏' : '已记录盈亏'} <small>{data?.currency}</small></span>
        <strong className={tone(summary?.pnl ?? null)}>{signed(summary?.pnl ?? null)}</strong>
        <small>{summary?.provisional ? '含暂估数据' : '按已记录的每日金额汇总'}</small></div>
      <div><span>MTD 收益率</span><strong className={tone(summary?.returnPct ?? null)}>{signed(summary?.returnPct ?? null, '%')}</strong>
        <small>{summary?.returnThroughDate ? '月初至 ' + summary.returnThroughDate.slice(5) : '月初以来数据未齐全'}</small></div>
      <div><span>盈亏天数</span><strong className="pnl-counts"><b className="pnl-profit">{summary?.profitDays ?? '—'}<small>盈</small></b><i>/</i><b className="pnl-loss">{summary?.lossDays ?? '—'}<small>亏</small></b></strong>
        <small>持平 {summary?.flatDays ?? '—'} 天</small></div>
      <div><span title="已取得收益率的交易日数 / 所选月份截至美东今天的交易日总数，不含休市日和未来日期。">已获取交易日</span><strong>{summary?.recordedDays ?? '—'}<small> / {summary?.expectedDays ?? '—'} 天</small></strong>
        <small>有收益率 / 应有交易日</small><br />
        <small>{summary ? summary.amountDays + ' 天金额可用' : '正在读取历史'}</small></div>
    </div>
    {data?.cashFlows && <div className="pnl-flow-summary" aria-label="本月入出金参考">
      <b>本月换汇推算 <small>USD</small></b>
      <span className="cash-flow-deposit">入金 +{cashFlowMoney(data.cashFlows.totals.deposits)}</span>
      <span className="cash-flow-withdrawal">出金 −{cashFlowMoney(data.cashFlows.totals.withdrawals)}</span>
      <span>净额 {cashFlowMoney(data.cashFlows.totals.net)}</span>
      <small>不计入盈亏{data.cashFlows.stale ? ' · 换汇记录待更新' : ''}</small>
    </div>}
    {error && <div className="pnl-notice" role="status"><span>{error}{data ? '，当前保留上次结果。' : ''}</span>
      <button onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} />重试</button></div>}
    {!loading && data && !summary?.recordedDays && <p className="pnl-notice">本月暂无可用的日度业绩，数据更新后会自动显示。</p>}
    {data?.offline && !!summary?.recordedDays && <p className="pnl-notice">正在显示已保存的业绩，等待 IB 更新。</p>}
    <div className="pnl-body">
      <div className="pnl-month">
        <div className="pnl-calendar-toolbar">
          <div className="pnl-legend"><span className="pnl-profit">▲ 盈利</span><span className="pnl-loss">▼ 亏损</span><span>＝ 持平</span></div>
          <div className="segmented" role="group" aria-label="日历显示方式">
            <button className={mode === 'amount' ? 'active' : ''} aria-pressed={mode === 'amount'} onClick={() => setMode('amount')}>金额</button>
            <button className={mode === 'return' ? 'active' : ''} aria-pressed={mode === 'return'} onClick={() => setMode('return')}>收益率</button>
          </div>
        </div>
        <div className="pnl-calendar-grid">
        <div className="pnl-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
        <div className="pnl-grid" role="group" aria-label={monthLabel(shownMonth) + '每日盈亏'}>
          {cells.map((date, index) => {
            if (!date) return <div className="pnl-cell pnl-padding" key={'padding-' + index} aria-hidden="true" />;
            const day = data?.days.find(item => item.date === date);
            const value = mode === 'amount' ? day?.pnl ?? null : day?.returnPct ?? null;
            const status = day ? dayLabel(day, data!.today) : loading ? '加载中' : '未加载';
            const today = date === (data?.today ?? localToday);
            const displayValue = value === null ? day?.status === 'closed' ? '休市' : '—' : signed(value, mode === 'return' ? '%' : '');
            const flows = day?.cashFlows ?? [];
            const totals = cashFlowTotals(flows);
            const flowLabels = [
              ...(totals.deposits > 0 ? ['入金（换汇推算）+' + cashFlowMoney(totals.deposits) + ' USD'] : []),
              ...(totals.withdrawals > 0 ? ['出金（换汇推算）−' + cashFlowMoney(totals.withdrawals) + ' USD'] : []),
            ];
            const label = date + '，' + (value === null ? status : signed(value, mode === 'return' ? '%' : ' ' + data?.currency) + '，' + status) + (flowLabels.length ? '，' + flowLabels.join('，') : '');
            return <button key={date} className={['pnl-cell', tone(value), day?.status === 'closed' ? 'pnl-closed' : '',
              selected?.date === date ? 'pnl-selected' : '', today ? 'pnl-today' : ''].join(' ')}
              disabled={!day || day.status === 'future'} aria-label={label} title={label} aria-pressed={selected?.date === date}
              aria-current={today ? 'date' : undefined} onClick={() => setSelection(date)}>
              <span className="pnl-day-number">{Number(date.slice(-2))}{today && <em>今</em>}
                {day?.provisional && <i title="暂估，可能修订" />}</span>
              <strong style={{ '--pnl-number-chars': displayValue.length } as React.CSSProperties}>{displayValue}</strong>
              <small>{value !== null
                ? day?.provisional ? status : ''
                : day?.status === 'future' || day?.status === 'closed' ? '' : status}</small>
              {!!flows.length && <span className="pnl-cell-flows">
                {totals.deposits > 0 && <span className="cash-flow-deposit">入 +{compactFlow(totals.deposits)}</span>}
                {totals.withdrawals > 0 && <span className="cash-flow-withdrawal">出 −{compactFlow(totals.withdrawals)}</span>}
              </span>}
            </button>;
          })}
        </div>
        </div>
      </div>
      <DayDetails day={selected} today={data?.today ?? localToday} currency={data?.currency ?? ''} loading={loading} />
    </div>
    <div className="pnl-footnote"><span>本地封板记录、日报优先 · 缺失日期由 IB 历史补充</span>
      <span>资金变动不明确时不展示金额；缺失日期不补零。点选日期查看精确金额。</span></div>
  </div>;
}
