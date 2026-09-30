import test from 'node:test';
import assert from 'node:assert/strict';
import type { DashboardState } from '../shared/types.js';
import { normalizeSnapshot } from '../server/normalize.js';
import { dashboardCard, isDashboardCommand } from '../server/bot/dashboard-card.js';

function fixture(): DashboardState {
  const time = '2026-09-28T08:00:00.000Z';
  const snapshot = normalizeSnapshot({ positions: [
    { contract_id: 1, contract_description: 'TEST', asset_class: 'STK', currency: 'USD', position: 10, market_value: 1000 },
    { contract_id: 2, contract_description: 'TEST [TEST  261016P00100000 100]', currency: 'USD', position: -1, market_value: -100 },
  ] }, { currency: 'USD', net_liquidation: 1500, total_cash_value: 600 }, { balances: [] }, { positions: time, summary: time, balances: time });
  return { snapshot, quotes: {}, history: Array.from({ length: 180 }, (_, i) => ({ time: new Date(Date.parse(time) + i * 60000).toISOString(), nav: 1500 + i })),
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

test('card uses bounded real history, absolute position values, and a local-only link', () => {
  const card = dashboardCard(fixture(), 'http://127.0.0.1:8048');
  const charts = card.body.elements.filter((e: any) => e.tag === 'chart') as any[];
  assert.equal(card.schema, '2.0');
  assert.equal(card.body.elements.length, 4);
  assert.equal(charts.length, 2);
  assert.equal(charts[0].chart_spec.data.values.length, 60);
  assert.equal(charts[0].chart_spec.data.values[0].value, 1500);
  assert.equal(charts[0].chart_spec.data.values.at(-1).value, 1679);
  assert.deepEqual(charts[1].chart_spec.data.values, [{ category: '股票', value: 1000 }, { category: '期权', value: 100 }]);
  assert.match(JSON.stringify(card), /不是当日收益/);
  assert.match(JSON.stringify(card), /仅服务所在电脑可打开/);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28000);
});
