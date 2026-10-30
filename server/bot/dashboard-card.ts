import type { Amount, DashboardState, Snapshot } from '../../shared/types.js';
import { dailyNavHistory, NAV_TIME_ZONE } from '../../shared/nav-history.js';

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

function historyChart(state: DashboardState): object {
  const timeZone = NAV_TIME_ZONE;
  const points = dailyNavHistory([...(state.dailyHistory ?? []), ...state.history], timeZone).slice(-60);
  if (points.length < 2) return group([md('**净值轨迹**'), md("<font color='grey'>至少积累两个日期的净值快照后显示；每天取最后一次采集，不补造历史。</font>")]);
  const format = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const minimum = Math.min(...points.map(point => point.nav));
  const maximum = Math.max(...points.map(point => point.nav));
  const padding = Math.max((maximum - minimum) * 0.15, Math.max(Math.abs(minimum), Math.abs(maximum)) * 0.001, 0.01);
  const unit = 10 ** Math.floor(Math.log10(padding));
  const axisMin = Math.floor((minimum - padding) / unit) * unit;
  const axisMax = Math.ceil((maximum + padding) / unit) * unit;
  return { tag: 'chart', aspect_ratio: '16:9', chart_spec: {
    type: 'line', title: { text: '净值轨迹 / ' + (state.snapshot?.account.currency ?? ''), subtext: '每日末次快照 · ' + timeZone },
    data: { values: points.map(p => ({ time: format.format(new Date(p.time)), value: p.nav })) },
    xField: 'time', yField: 'value', color: ['#3370ff'],
    point: { style: { size: 5 } },
    axes: [
      { orient: 'bottom', sampling: true, tickCount: 6, label: { autoHide: true, autoRotate: false } },
      { orient: 'left', type: 'linear', zero: false, nice: false, min: axisMin, max: axisMax, tickCount: 5 },
    ],
  } };
}

function allocationChart(snapshot: Snapshot | null): object {
  const unavailable = (reason: string) => group([md('**持仓分布**'), md("<font color='grey'>" + reason + '</font>')]);
  if (!snapshot) return unavailable('暂无持仓数据。');
  const stocks = snapshot.positions.filter(position => position.kind === 'stock');
  if (snapshot.account.currency === 'UNKNOWN' || stocks.some(p => p.currency !== snapshot.account.currency || !finite(p.value))) {
    return unavailable('正股包含其他币种或缺失市值，暂不汇总分布。');
  }
  const cash = snapshot.account.cash;
  if (!finite(cash)) return unavailable('现金余额未知，暂不汇总正股与现金分布。');
  const amounts = stocks.map(p => ({ category: p.symbol + (p.value! < 0 ? '（空头）' : ''), amount: p.value! }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  amounts.push({ category: cash < 0 ? '现金（借款）' : '现金', amount: cash });
  const total = amounts.reduce((sum, item) => sum + Math.abs(item.amount), 0);
  if (!total) return unavailable('正股与现金金额均为零，暂无分布图。');
  const values = amounts.map(item => ({ ...item, value: Math.abs(item.amount),
    label: item.category + ' · ' + (Math.abs(item.amount) / total * 100).toFixed(1) + '%' }));
  const colors = ['#3370ff', '#7f6bff', '#00a6a6', '#f5a623', '#e86a92', '#4bba79', '#4db7e5', '#ab70d6', '#e47844', '#94b447', '#bc7199', '#588b8b'];
  const signed = amounts.some(item => item.amount < 0);
  return { tag: 'chart', aspect_ratio: '4:3', height: Math.min(950, Math.max(320, values.length * 28 + 100)) + 'px', chart_spec: {
    type: 'pie', title: { text: '正股与现金 / ' + snapshot.account.currency,
      subtext: signed ? '绝对金额占比 · 空头/借款取绝对值 · 不含期权' : '正股市值 + 现金占比 · 不含期权' },
    // VChart's default outerRadius is 0.6; equal radii make the ring invisible.
    data: { values }, valueField: 'value', categoryField: 'label', outerRadius: 0.85, innerRadius: 0.5,
    color: [...stocks.map((_stock, index) => colors[index % colors.length]), '#8f959e'],
    legends: { visible: true, orient: 'right' },
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
    md('净值轨迹按美东日期每天一个点，纵轴按所示净值范围缩放；取当天末次采集，今日数据仍会更新，非收盘净值或收益率。', 'notation'),
    md('发送“看板”查看最新快照；发送“刷新”重新采集。', 'notation'),
    md(local ? '[完整网页（仅服务所在电脑可打开）](' + url.href + ')' : '[打开完整网页](' + url.href + ')', 'notation')];
  return {
    schema: '2.0',
    config: { width_mode: 'default', update_multi: true, summary: { content: '持仓看板 · ' + status } },
    header: { title: { tag: 'plain_text', content: '持仓看板' }, subtitle: { tag: 'plain_text', content: status },
      template: !snapshot || stale ? 'grey' : 'blue', icon: { tag: 'standard_icon', token: 'chart_colorful' } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements: [
      metrics(snapshot), historyChart(state), allocationChart(snapshot), group(footer),
    ] },
  };
}
