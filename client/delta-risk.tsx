import type { DeltaRisk, RiskObservation } from '../shared/types';
import './delta-risk.css';
const fmt = (v: number | null | undefined, digits = 2) => v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits });
const usd = (v: number | null | undefined) => v == null ? '—' : '$' + fmt(v);
const time = (v?: string | null) => v ? new Date(v).toLocaleString('zh-CN') : '—';
const labels = { current: '当前估算', historical: '休市参考', reference: '上次完整 · 待更新', stale: '已过期', incomplete: '数据未齐', unavailable: '不可用' };
export function DeltaLeverage({ risk }: { risk?: DeltaRisk | null }) {
  return <span title={risk ? `${risk.reason ?? '同标的先抵消，跨标的不抵消'} · 计算 ${time(risk.calculatedAt)}` : '等待采集'}>{risk?.leverage == null ? '—' : `${fmt(risk.leverage)}×`}{(risk?.status === 'historical' || risk?.status === 'reference') && <small className="cell-sub">{risk.status === 'reference' ? '上次完整 · 待更新' : '休市参考'}</small>}</span>;
}
function observation(value: RiskObservation | null) {
  return value ? `嘉信 · ${value.status === 'REALTIME' ? '非延迟' : value.status === 'DELAYED' ? '延迟行情' : '延迟状态未知'} · 接收 ${time(value.receivedAt)} · 源时间 ${time(value.sourceTime)}` : '无有效行情';
}
export function DeltaRiskPanel({ risk }: { risk?: DeltaRisk | null }) {
  return <article className="panel delta-panel">
    <div className="panel-heading"><h2>Delta 敞口与整体杠杆</h2><span className="tiny">{risk ? labels[risk.status] : '等待采集'}</span></div>
    <p className="muted">同标的先抵消，跨标的不抵消。备兑卖 Call 降低多头敞口，卖 Put 增加多头敞口。数据完整性指行情是否齐全，与 Call 是否备兑无关。</p>
    {!risk ? <p className="muted">等待首次风险计算。</p> : <>
      {risk.status === 'reference' && <div className="delta-reference" role="status">显示 {time(risk.calculatedAt)} 的完整快照。以下杠杆、持仓、行情和净值均沿用该快照，当前更新尚未完成。</div>}
      <div className="delta-metrics">
        <div><span>整体 Delta 杠杆</span><strong><DeltaLeverage risk={risk} /></strong></div>
        <div><span>带方向净敞口 / 净值</span><strong>{risk.netLeverage == null ? '—' : `${fmt(risk.netLeverage)}×`}</strong></div>
        <div><span>已计入绝对敞口</span><strong>{usd(risk.coveredGrossExposure)}</strong></div>
        <div><span>{risk.status === 'reference' ? '上次完整数据' : '数据完整性'}</span><strong>{risk.covered} / {risk.total}</strong></div>
      </div>
      {risk.reason && <p className="amber">{risk.reason}</p>}
      {(risk.requiresLogin || risk.latestAttempt?.covered === 0 && risk.total > 0) && <a className="button secondary" href="/tos-login/">{risk.requiresLogin ? '重新连接嘉信行情' : '检查嘉信连接'}</a>}
      {risk.latestAttempt && <p className="micro-note">最近尝试 {time(risk.latestAttempt.at)}：当前行情可用 {risk.latestAttempt.covered}/{risk.latestAttempt.total} 项；未覆盖上次完整结果。</p>}
      <p className="micro-note">计算 {time(risk.calculatedAt)} · IB 净值 {usd(risk.nav)}（{time(risk.navAt)}）。活跃时段随账户采集更新，默认 60 秒；休市低频采集，数据齐全时仍计算并展示休市参考值。</p>
      <div className="table-scroll"><table><thead><tr><th>标的</th><th className="numeric">股票股数</th><th className="numeric">期权等效股数</th><th className="numeric">合计等效股数</th><th className="numeric">净敞口 / USD</th><th>数据状态</th></tr></thead>
        <tbody>{risk.underlyings.map(g => <tr key={g.symbol}><td>{g.symbol}</td><td className="numeric">{fmt(g.stockShares)}</td><td className="numeric">{fmt(g.optionShares)}</td><td className="numeric">{fmt(g.equivalentShares)}</td><td className="numeric">{usd(g.exposure)}</td><td>{g.complete ? '已全部计入' : '部分行情待更新'}</td></tr>)}</tbody>
      </table></div>
      <details><summary>逐笔持仓与行情来源</summary><div className="table-scroll"><table><thead><tr><th>持仓</th><th className="numeric">数量 × 乘数</th><th className="numeric">Delta</th><th className="numeric">正股价格</th><th className="numeric">等效股数</th><th className="numeric">敞口 / USD</th><th>状态与来源</th></tr></thead><tbody>
        {risk.rows.map(r => <tr key={r.id}><td>{r.description}</td><td className="numeric">{fmt(r.quantity)} × {fmt(r.multiplier)}</td><td className="numeric" title={observation(r.greek)}>{fmt(r.delta, 4)}</td><td className="numeric" title={observation(r.price)}>{usd(r.price?.value)}</td><td className="numeric">{fmt(r.equivalentShares)}</td><td className="numeric">{usd(r.exposure)}</td><td className="delta-source"><span className={r.reason ? 'amber' : ''}>{r.reason ?? '已计入'}</span><small>{observation(r.price)}</small>{r.kind === 'option' && <small>Delta：{observation(r.greek)}</small>}</td></tr>)}
      </tbody></table></div></details>
      <p className="micro-note">杠杆 = 各标的净敞口绝对值之和 ÷ IB 净值。Delta 只表示当前价格附近的一阶敏感度，不代表大跌损失或保证金要求；不同标的的等效股数不相加。旧净值不随独立行情重估。</p>
    </>}
  </article>;
}
