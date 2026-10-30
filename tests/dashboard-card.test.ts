import test from 'node:test';
import assert from 'node:assert/strict';
import type { DashboardState } from '../shared/types.js';
import { normalizeSnapshot } from '../server/normalize.js';
import { dashboardCard, isDashboardCommand } from '../server/bot/dashboard-card.js';
import { dailyNavHistory } from '../shared/nav-history.js';

test('daily points respect midnight, take the latest sample and do not fill gaps', () => {
  const old = { time: '2026-10-07T14:00:00Z', nav: 1400 };
  const latest = { time: '2026-10-10T15:59:59Z', nav: 1520 };
  const next = { time: '2026-10-10T16:00:00Z', nav: 1530 };
  const history = [latest, old, { time: '2026-10-10T00:00:00Z', nav: 1500 }, next,
    { time: 'invalid', nav: 0 }, { time: next.time, nav: NaN }];
  assert.deepEqual(dailyNavHistory(history, 'Asia/Shanghai'), [old, latest, next]);
  assert.deepEqual(dailyNavHistory(history, 'UTC'), [old, next]);
  const days = Array.from({ length: 200 }, (_, i) => ({ time: new Date(i * 86400000).toISOString(), nav: i }));
  assert.deepEqual(dailyNavHistory(days), days.slice(-180));
});

test('default NAV dates follow New York midnight across both DST transitions', () => {
  for (const times of [
    ['2026-03-08T04:59:59Z', '2026-03-08T05:00:00Z', '2026-03-09T03:59:59Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01T03:59:59Z', '2026-11-01T04:00:00Z', '2026-11-02T04:59:59Z', '2026-11-02T05:00:00Z'],
  ]) {
    const points = times.map((time, nav) => ({ time, nav }));
    assert.deepEqual(dailyNavHistory([...points].reverse()), [points[0], points[2], points[3]]);
  }
});

function fixture(): DashboardState {
  const time = '2026-09-28T08:00:00.000Z';
  const snapshot = normalizeSnapshot({ positions: [
    { contract_id: 1, contract_description: 'TEST', asset_class: 'STK', currency: 'USD', position: 10, market_value: 1000 },
    { contract_id: 2, contract_description: 'TEST [TEST  261016P00100000 100]', currency: 'USD', position: -1, market_value: -100 },
  ] }, { currency: 'USD', net_liquidation: 1500, total_cash_value: 600 }, { balances: [] }, { positions: time, summary: time, balances: time });
  return { snapshot, quotes: {}, history: Array.from({ length: 180 }, (_, i) => ({ time: new Date(Date.parse(time) + i * 86400000).toISOString(), nav: 1500 + i })),
    status: { connected: true, stale: false, refreshing: false, lastAttempt: null, nextAttempt: null, error: null, quoteError: null, pollSeconds: 60, staleSeconds: 180, quoteBatchSize: 4 } };
}

test('missing, mixed-currency and stale data stay explicit', () => {
  const state = fixture();
  state.snapshot!.positions[0].value = null;
  state.status.stale = true;
  let card = dashboardCard(state, 'https://portfolio.example');
  assert.match(card.header.subtitle.content, /过期/);
  assert.match(JSON.stringify(card), /缺失市值/);
  assert.match(JSON.stringify(card), /未知/);
  state.snapshot!.positions[0].value = 1000;
  state.snapshot!.positions[0].currency = 'EUR';
  card = dashboardCard(state, 'https://portfolio.example');
  assert.equal(card.body.elements.filter((e: any) => e.tag === 'chart').length, 1);
  state.snapshot = null; state.history = [];
  card = dashboardCard(state, 'https://portfolio.example');
  assert.match(card.header.subtitle.content, /尚无快照/);
  assert.equal(card.body.elements.filter((e: any) => e.tag === 'chart').length, 0);
});

test('dashboard commands do not intercept analysis questions', () => {
  for (const command of ['看板', '打开看板', '请展示账户看板', 'dashboard', '看看看板']) assert.ok(isDashboardCommand(command));
  for (const question of ['看板里的净值是什么意思', '为什么看板没有收益率', '风险']) assert.equal(isDashboardCommand(question), false);
});

test('allocation includes every stock and cash even when excluded options lack values', () => {
  const state = fixture(), snapshot = state.snapshot!;
  const stock = snapshot.positions[0];
  snapshot.positions = Array.from({ length: 11 }, (_, i) => ({ ...stock, id: i + 10, symbol: 'STOCK' + i, value: 100 + i }));
  snapshot.positions.push({ ...stock, kind: 'option', id: 99, currency: 'EUR', value: null });
  snapshot.analysis.allBaseCurrency = false;
  const card = dashboardCard(state, 'https://portfolio.example');
  const pie = card.body.elements.find((e: any) => e.chart_spec?.type === 'pie') as any;
  const values = pie.chart_spec.data.values;
  assert.equal(values.length, 12);
  assert.equal(new Set(values.map((p: any) => p.category)).size, 12);
  for (let i = 0; i < 11; i++) assert.equal(values.find((p: any) => p.category === 'STOCK' + i).value, 100 + i);
  assert.equal(values.at(-1).category, '现金');
  assert.equal(values.at(-1).value, 600);
  assert.equal(pie.chart_spec.categoryField, 'label');
  assert.equal(pie.chart_spec.legends.orient, 'right');
  assert.ok(parseInt(pie.height) >= 400);
});

test('card merges daily archive with current samples and waits for a second date', () => {
  const state = fixture();
  state.history = [
    { time: '2026-10-11T03:59:59Z', nav: 1520 },
    { time: '2026-10-10T04:00:00Z', nav: 1500 },
  ];
  let card = dashboardCard(state, 'https://portfolio.example');
  assert.match(JSON.stringify(card), /两个日期/);
  state.dailyHistory = [{ time: '2026-10-07T14:00:00Z', nav: 1400 }];
  card = dashboardCard(state, 'https://portfolio.example');
  const line = card.body.elements.find((e: any) => e.chart_spec?.type === 'line') as any;
  assert.match(line.chart_spec.title.subtext, /America\/New_York/);
  assert.deepEqual(line.chart_spec.data.values, [
    { time: '2026/10/07', value: 1400 }, { time: '2026/10/10', value: 1520 },
  ]);
  assert.match(JSON.stringify(card), /今日数据仍会更新/);
});

test('cash-only accounts work; missing cash and signed exposures stay explicit', () => {
  const state = fixture();
  state.snapshot!.positions = [];
  let card = dashboardCard(state, 'https://portfolio.example');
  let pie = card.body.elements.find((e: any) => e.chart_spec?.type === 'pie') as any;
  assert.equal(pie.chart_spec.data.values[0].label, '现金 · 100.0%');
  state.snapshot!.account.cash = null;
  card = dashboardCard(state, 'https://portfolio.example');
  assert.match(JSON.stringify(card), /现金余额未知/);
  state.snapshot!.account.cash = -200;
  card = dashboardCard(state, 'https://portfolio.example');
  pie = card.body.elements.find((e: any) => e.chart_spec?.type === 'pie') as any;
  assert.equal(pie.chart_spec.data.values[0].category, '现金（借款）');
  assert.equal(pie.chart_spec.data.values[0].amount, -200);
  assert.equal(pie.chart_spec.data.values[0].value, 200);
  assert.match(pie.chart_spec.title.subtext, /绝对金额/);
});

test('card uses recent daily history and a visible allocation ring', () => {
  const card = dashboardCard(fixture(), 'http://127.0.0.1:8048');
  const charts = card.body.elements.filter((e: any) => e.tag === 'chart') as any[];
  assert.equal(card.schema, '2.0');
  assert.equal(card.body.elements.length, 4);
  assert.equal(charts.length, 2);
  assert.equal(charts[0].chart_spec.data.values.length, 60);
  assert.equal(charts[0].chart_spec.data.values[0].value, 1620);
  assert.equal(charts[0].chart_spec.data.values.at(-1).value, 1679);
  assert.deepEqual(charts[1].chart_spec.data.values, [
    { category: 'TEST', amount: 1000, value: 1000, label: 'TEST · 62.5%' },
    { category: '现金', amount: 600, value: 600, label: '现金 · 37.5%' },
  ]);
  assert.ok(charts[1].chart_spec.outerRadius > charts[1].chart_spec.innerRadius);
  assert.ok(charts[1].chart_spec.innerRadius > 0 && charts[1].chart_spec.outerRadius <= 1);
  assert.equal(charts[1].aspect_ratio, '4:3');
  assert.match(JSON.stringify(card), /不是当日收益/);
  assert.match(JSON.stringify(card), /仅服务所在电脑可打开/);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28000);
});

test('NAV axis magnifies daily changes while enclosing every actual value', () => {
  const state = fixture();
  for (const navs of [[49300, 49400, 49600], [50000, 50000], [0, 0], [-200, -180], [0.1, 0.12]]) {
    state.history = navs.map((nav, i) => ({ time: new Date(Date.UTC(2026, 9, i + 1)).toISOString(), nav }));
    const card = dashboardCard(state, 'https://portfolio.example');
    const spec = (card.body.elements.find((e: any) => e.chart_spec?.type === 'line') as any).chart_spec;
    const axis = spec.axes.find((a: any) => a.orient === 'left');
    assert.equal(axis.zero, false);
    assert.equal(axis.nice, false);
    assert.ok(Number.isFinite(axis.min) && Number.isFinite(axis.max));
    assert.ok(axis.min < Math.min(...navs) && axis.max > Math.max(...navs));
    assert.deepEqual(spec.data.values.map((p: any) => p.value), navs);
    if (navs[0] > 49000) {
      assert.ok(axis.min > 48000);
      assert.ok(axis.max - axis.min < 1000);
    }
    assert.match(JSON.stringify(card), /纵轴按所示净值范围缩放/);
  }
});
