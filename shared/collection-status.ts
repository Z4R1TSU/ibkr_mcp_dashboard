import type { DashboardState } from './types.js';
type Status = DashboardState['status'];

export function collectionLabel(status: Status | undefined, stale: boolean): string {
  if (status?.refreshing) {
    const labels = { queued: '等待 IB 请求', connecting: '正在连接 IB', positions: '正在读取持仓', summary: '正在读取净值', balances: '正在读取余额', idle: '正在采集账户', quotes: '正在采集账户' };
    return labels[status.phase ?? 'idle'];
  }
  if (status?.phase === 'quotes') return '账户已采集 · 更新行情';
  if (status?.error) return status.connected ? '读取失败 · 等待重试' : '等待 IB 授权';
  return stale ? '快照待更新' : 'IB 快照已采集';
}

export function collectionSchedule(status?: Status, now = Date.now()): string {
  if ((status?.refreshing || status?.phase === 'quotes') && status.lastAttempt) {
    return `本次已用时 ${Math.max(0, Math.floor((now - Date.parse(status.lastAttempt)) / 1000))} 秒`;
  }
  if (status?.nextAttempt) {
    const seconds = Math.max(0, Math.ceil((Date.parse(status.nextAttempt) - now) / 1000));
    // Closed-market reads are hours apart; show the clock time instead of a long countdown.
    if (!status.error && seconds > 3600) return '休市低频采集 · 下次 ' + new Date(status.nextAttempt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    return `${status.error ? '重试' : '下次采集'}倒计时 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return `自动采集间隔 ${status?.pollSeconds ?? 60} 秒`;
}
