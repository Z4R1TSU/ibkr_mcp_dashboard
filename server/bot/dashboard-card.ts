import type { Amount, DashboardState, Snapshot } from '../../shared/types.js';

export function isDashboardCommand(text: string): boolean {
  return /^(?:请)?(?:(?:打开|查看|展示|看看|显示|发一下|给我看看)\s*)?(?:账户|持仓)?看板[。！!？?]?$|^dashboard$/i.test(text.trim());
}

const md = (content: string, textSize = 'normal') => ({ tag: 'markdown', content, text_size: textSize });
const escape = (text: string) => text.replace(/[&<>*_\[\]()#~]/g, c => '&#' + c.charCodeAt(0) + ';');
const finite = (value: Amount): value is number => typeof value === 'number' && Number.isFinite(value);
const money = (value: Amount, currency: string) => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + escape(currency) : '未知';
const column = (elements: object[], background = 'default') => ({
  tag: 'column', width: 'weighted', weight: 1, padding: '12px', vertical_spacing: '8px', background_style: background, elements,
});
const group = (elements: object[]) => ({ tag: 'column_set', flex_mode: 'none', columns: [column(elements)] });

function metrics(snapshot: Snapshot | null): object {
  const a = snapshot?.account;
  const currency = a?.currency ?? '';
  return group([
    { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '12px', columns: [
      column([md('账户净值', 'notation'), md('**' + money(a?.nav ?? null, currency) + '**', 'heading-2')], 'blue-50'),
    ] },
    { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '12px', columns: [
      column([md('现金余额', 'notation'), md('**' + money(a?.cash ?? null, currency) + '**')], 'grey-50'),
      column([md('未实现盈亏', 'notation'), md('**' + money(a?.unrealizedPnl ?? null, currency) + '**'), md("<font color='grey'>不是当日收益</font>", 'notation')], 'grey-50'),
    ] },
    md('剩余流动性：**' + money(a?.excessLiquidity ?? null, currency) + '**'),
  ]);
}

function historyChart(state: DashboardState, timeZone: string): object {
  const points = state.history.filter(p => Number.isFinite(p.nav) && Number.isFinite(Date.parse(p.time)))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-180);
  if (points.length < 2) return group([md('**净值轨迹**'), md("<font color='grey'>至少采集两个净值快照后显示，暂无足够数据。</font>")]);
  // Bound the payload, keeping both endpoints and chronological spacing.
  const sampled = points.length <= 60 ? points : Array.from({ length: 60 }, (_, i) => points[Math.round(i * (points.length - 1) / 59)]);
  const format = new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return { tag: 'chart', aspect_ratio: '16:9', chart_spec: {
    type: 'line', title: { text: '净值轨迹 / ' + (state.snapshot?.account.currency ?? ''), subtext: '实际采集快照 · 非收益率曲线 · ' + timeZone },
    data: { values: sampled.map(p => ({ time: format.format(new Date(p.time)), value: p.nav })) },
    xField: 'time', yField: 'value', color: ['#3370ff'],
  } };
}

function allocationChart(snapshot: Snapshot | null): object {
  const unavailable = (reason: string) => group([md('**持仓分布**'), md("<font color='grey'>" + reason + '</font>')]);
  if (!snapshot || !snapshot.positions.length) return unavailable('暂无持仓数据。');
  if (!snapshot.analysis.allBaseCurrency || snapshot.positions.some(p => p.currency !== snapshot.account.currency || !finite(p.value))) {
    return unavailable('持仓包含其他币种或缺失市值，暂不汇总分布。');
  }
  const values = [
    { kind: 'stock', label: '股票' }, { kind: 'option', label: '期权' }, { kind: 'other', label: '其他' },
  ].map(c => ({ category: c.label, value: snapshot.positions.filter(p => p.kind === c.kind).reduce((sum, p) => sum + Math.abs(p.value!), 0) }))
    .filter(p => p.value > 0);
  if (!values.length) return unavailable('持仓绝对市值为零，暂无分布图。');
  return { tag: 'chart', aspect_ratio: '16:9', chart_spec: {
    type: 'pie', title: { text: '持仓分布 / ' + snapshot.account.currency, subtext: '绝对市值 · 不含现金 · 空头取绝对值' },
    data: { values }, valueField: 'value', categoryField: 'category', innerRadius: 0.6,
    color: ['#3370ff', '#7f6bff', '#a5bbff'], legends: { visible: true },
  } };
}

export function dashboardCard(state: DashboardState, publicUrl: string, timeZone = 'Asia/Shanghai') {
  const snapshot = state.snapshot;
  const stale = !state.status.connected || state.status.stale;
  const status = !snapshot ? '尚无快照，请先连接 IB' : !state.status.connected ? 'IB 授权待恢复 · 以下为旧快照' : stale ? '快照已过期' : '账户快照';
  const time = snapshot?.fetchedAt && Number.isFinite(Date.parse(snapshot.fetchedAt))
    ? new Date(snapshot.fetchedAt).toLocaleString('zh-CN', { timeZone, hour12: false }) : '尚未采集';
  const url = new URL(publicUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const footer = [md("<font color='grey'>采集时间：" + time + '（' + escape(timeZone) + '）</font>', 'notation'),
    md('发送“看板”查看最新快照；发送“刷新”重新采集。', 'notation'),
    md(local ? '[完整网页（仅服务所在电脑可打开）](' + url.href + ')' : '[打开完整网页](' + url.href + ')', 'notation')];
  return {
    schema: '2.0',
    config: { width_mode: 'default', update_multi: true, summary: { content: '持仓看板 · ' + status } },
    header: { title: { tag: 'plain_text', content: '持仓看板' }, subtitle: { tag: 'plain_text', content: status },
      template: !snapshot || stale ? 'grey' : 'blue', icon: { tag: 'standard_icon', token: 'chart_colorful' } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements: [
      metrics(snapshot), historyChart(state, timeZone), allocationChart(snapshot), group(footer),
    ] },
  };
}
