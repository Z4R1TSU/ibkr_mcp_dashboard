import type { DeltaInput, DeltaRisk, DeltaRiskRow, Position, RiskObservation, Snapshot } from '../shared/types.js';
import { freshFor, marketActive } from './market-hours.js';
import { tosSymbol } from './tos-market.js';
export const DELTA_TTL = 120000;
export const CLOSED_RISK_REASON = '休市参考，按该快照的持仓、行情和 IB 净值计算，非盘中实时估值。';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const positionKey = (snapshot: Snapshot) => JSON.stringify([snapshot.account.currency,
  snapshot.positions.filter(p => p.quantity !== 0).map(p => [p.id, p.kind, p.symbol, p.currency, p.quantity, p.option]).sort((a, b) => Number(a[0]) - Number(b[0]))]);
function current(value: RiskObservation | null, now: number): value is RiskObservation {
  const age = now - Date.parse(value?.receivedAt ?? '');
  return !!value && finite(value.value) && Number.isFinite(age) && age >= -5000 && age <= DELTA_TTL;
}
function validDelta(p: Position, value: number | null) {
  return finite(value) && (p.option?.right === 'C' ? value >= 0 && value <= 1 : value >= -1 && value <= 0);
}
export function calculateDeltaRisk(snapshot: Snapshot, inputs: Record<number, DeltaInput>, now: number, staleSeconds: number): DeltaRisk {
  const deadlines = [now + DELTA_TTL];
  const rows: DeltaRiskRow[] = snapshot.positions.filter(p => p.quantity !== 0).map(p => {
    const input = inputs[p.id];
    const price = input?.price ?? null, greek = input?.delta ?? null;
    const multiplier = p.kind === 'stock' ? 1 : p.option?.multiplier ?? null;
    const delta = p.kind === 'stock' ? 1 : greek?.value ?? null;
    let reason: string | null = null;
    if (snapshot.account.currency !== 'USD' || p.currency !== 'USD') reason = '未支持的币种，未进行汇率换算';
    else if (!finite(p.quantity)) reason = '持仓数量缺失';
    else if (!tosSymbol(p)) reason = '未匹配的标准股票或期权合约';
    else if (!current(price, now) || price.value <= 0) reason = input?.reason ?? '正股报价缺失或过期';
    else if (p.kind === 'option' && (!current(greek, now) || !validDelta(p, delta))) reason = input?.reason ?? 'Delta 缺失、过期或未核验';
    const shares = reason === null ? p.quantity! * multiplier! * delta! : null;
    const exposure = shares === null ? null : shares * price!.value;
    if (shares !== null && (!finite(shares) || !finite(exposure))) reason = '敞口数值无效';
    if (!reason) for (const observation of [price, p.kind === 'option' ? greek : null]) {
      if (observation) deadlines.push(Date.parse(observation.receivedAt) + DELTA_TTL);
    }
    return { id: p.id, description: p.description, underlying: p.option?.underlying ?? p.symbol,
      currency: p.currency, kind: p.kind, quantity: p.quantity, multiplier, delta,
      equivalentShares: reason ? null : shares, exposure: reason ? null : exposure, price, greek, reason };
  });
  const groups = new Map<string, DeltaRisk['underlyings'][number]>();
  for (const row of rows.filter(r => r.currency === 'USD')) {
    const group = groups.get(row.underlying) ?? { symbol: row.underlying, stockShares: 0, optionShares: 0, equivalentShares: 0, exposure: 0, complete: true };
    if (row.exposure === null) group.complete = false;
    else {
      group[row.kind === 'stock' ? 'stockShares' : 'optionShares'] += row.equivalentShares!;
      group.equivalentShares += row.equivalentShares!;
      group.exposure += row.exposure;
    }
    groups.set(row.underlying, group);
  }
  const underlyings = [...groups.values()].sort((a, b) => Math.abs(b.exposure) - Math.abs(a.exposure));
  const coveredGrossExposure = underlyings.reduce((sum, g) => sum + Math.abs(g.exposure), 0);
  const coveredNetExposure = underlyings.reduce((sum, g) => sum + g.exposure, 0);
  const covered = rows.filter(r => !r.reason).length;
  const oldest = Math.min(...Object.values(snapshot.sources).map(t => Date.parse(t)));
  const accountDeadline = oldest + freshFor(oldest, staleSeconds * 1000);
  let reason = covered !== rows.length ? '部分持仓行情缺失或过期' : null;
  if (snapshot.account.currency !== 'USD') reason = '仅支持 USD 账户';
  else if (!finite(snapshot.account.nav) || snapshot.account.nav <= 0) reason = '账户净值缺失或非正';
  else if (!finite(accountDeadline) || oldest > now + 5000 || now > accountDeadline) reason = 'IB 账户快照已过期';
  if (!finite(coveredGrossExposure) || !finite(coveredNetExposure)) reason = '敞口合计无效';
  deadlines.push(finite(accountDeadline) ? accountDeadline : now);
  const active = marketActive(now);
  return { version: 1, positionKey: positionKey(snapshot), calculatedAt: new Date(now).toISOString(),
    navAt: snapshot.sources.summary, nav: snapshot.account.nav, validUntil: new Date(Math.min(...deadlines)).toISOString(),
    status: reason ? covered === rows.length ? 'unavailable' : 'incomplete' : active ? 'current' : 'historical',
    reason: reason ?? (active ? null : CLOSED_RISK_REASON),
    total: rows.length, covered, leverage: reason ? null : coveredGrossExposure / snapshot.account.nav!,
    netLeverage: reason ? null : coveredNetExposure / snapshot.account.nav!, coveredGrossExposure,
    coveredNetExposure, rows, underlyings };
}
/** Keep a coherent, explicitly dated complete result through failed refreshes. */
export function retainCompleteRisk(attempt: DeltaRisk, previous: DeltaRisk | null): DeltaRisk {
  if (attempt.status === 'current' || attempt.status === 'historical' || !previous || previous.positionKey !== attempt.positionKey) return attempt;
  return { ...previous, status: 'reference', requiresLogin: attempt.requiresLogin,
    reason: attempt.reason ?? '等待下一份完整风险快照',
    latestAttempt: { at: attempt.calculatedAt, covered: attempt.covered, total: attempt.total, reason: attempt.reason } };
}
/** Validity labels may change on a heartbeat; observations and valuation never do. */
export function deltaRiskView(risk: DeltaRisk | null | undefined, now: number): DeltaRisk | null {
  if (!risk) return null;
  if (!marketActive(now) && (risk.status === 'current' || risk.status === 'historical') && !risk.requiresLogin)
    return { ...risk, status: 'historical', reason: CLOSED_RISK_REASON };
  if (risk.status === 'reference') return risk;
  if (risk.status === 'historical' || now > Date.parse(risk.validUntil)) {
    if (risk.covered === risk.total && risk.leverage !== null)
      return { ...risk, status: 'reference', reason: '等待更新，展示上次完整快照及其原始时间' };
    return { ...risk, status: 'stale', leverage: null, netLeverage: null, reason: risk.reason ?? '暂无完整风险快照，等待更新' };
  }
  return risk;
}
