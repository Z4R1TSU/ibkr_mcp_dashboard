import type { Amount, DashboardState } from '../../shared/types.js';

const number = (v: Amount) => v === null ? '未知' : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
const money = (v: Amount, currency: string) => number(v) + (v === null ? '' : ' ' + currency);
const percent = (v: Amount) => v === null ? '未知' : number(v * 100) + '%';

export function freshness(state: DashboardState): string {
  const time = state.snapshot?.fetchedAt;
  const label = !state.status.connected ? 'IB 授权待恢复；以下为旧快照' : state.status.stale ? '快照已过期' : '最近账户快照';
  return label + '\n采集时间：' + (time ? new Date(time).toISOString() : '尚未采集');
}

export function dataWarning(state: DashboardState): string {
  if (state.status.connected && !state.status.stale) return '';
  return '\n\n' + (!state.status.connected ? 'IB 授权待恢复，以上使用旧快照。' : '快照已过期，以上数据可能尚未更新。');
}

export function accountSummary(state: DashboardState): string {
  if (!state.snapshot) return '尚无账户快照。请先连接 IB。';
  const a = state.snapshot.account, s = state.snapshot.analysis;
  return [
    '账户摘要',
    '净值：' + money(a.nav, a.currency),
    '现金：' + money(a.cash, a.currency),
    '未实现盈亏：' + money(a.unrealizedPnl, a.currency),
    '剩余流动性：' + money(a.excessLiquidity, a.currency),
    '前三大股票 / 净值：' + percent(s.topThreeWeight),
    '持仓数：' + state.snapshot.positions.length,
  ].join('\n');
}

export function holdings(state: DashboardState): string {
  if (!state.snapshot) return '尚无持仓快照。';
  const positions = state.snapshot.positions;
  const rows = positions.slice(0, 80).map(p => (p.option ? p.option.underlying + ' ' + p.option.expiry + ' ' + p.option.strike + p.option.right : p.symbol)
    + '｜数量 ' + number(p.quantity) + '｜市值 ' + money(p.value, p.currency) + '｜未实现盈亏 ' + money(p.unrealizedPnl, p.currency));
  return ['持仓明细', ...rows, positions.length > 80 ? '仅列前 80 项，完整明细请查看看板。' : ''].filter(Boolean).join('\n');
}

export function risks(state: DashboardState): string {
  if (!state.snapshot) return '尚无可分析的账户快照。';
  const { analysis: a, account } = state.snapshot;
  return [
    '账户风险与期权',
    '前三大股票 / 净值：' + percent(a.topThreeWeight),
    '现金 / 净值：' + percent(a.cashRatio),
    '短 Put 全部被行权的金额：' + money(a.shortPutNotional, account.currency),
    '对应现金缺口：' + money(a.shortPutCashGap, account.currency),
    ...a.options.slice(0, 50).map(o => o.underlying + ' ' + o.expiry + ' ' + o.right + '｜' + o.contracts + ' 张｜行权金额 ' + money(o.strikeNotional, o.currency)),
    '行权金额是条件性资金需求，不是当前亏损或保证金。',
    ...a.warnings,
  ].join('\n');
}

export const HELP = [
  '持仓助手',
  '看板：在聊天内查看关键指标、持仓分布和净值轨迹',
  '摘要 / 持仓 / 风险 / 到期 / 今年换汇 / 状态 / 刷新 / 连接 IB',
  '/research AAPL：TradingAgents 后台只读研究；固定命令，所有角色复用当前模型，绝不下单',
  '/research status / report / cancel：研究进度、完整报告、停止研究',
  '订阅日报北京时间 11:00 发送：每天按指定时区推送',
  '取消日报：停止日报',
  '开启提醒 / 关闭提醒：IB 授权、快照失效与恢复提醒',
  '日报 / 推送一次：私聊查看上一美股交易日报，含盈亏与行情复盘',
  '偏好 你的要求：保存供模型参考的偏好（最多 1000 字）',
  '查看偏好 / 清除偏好',
  '清空上下文：清空当前对话的多轮记忆；群聊需账户管理员操作',
  '其他问题：模型配置后，结合账户快照回答。',
  '群聊需 @ 机器人；订阅、偏好和授权请由账户管理员私聊操作。',
].join('\n');
