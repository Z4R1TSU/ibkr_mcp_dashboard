import test from 'node:test';
import assert from 'node:assert/strict';
import { forexReport, ForexHistory } from '../server/forex.js';

const trade = (id: string, side: string, size: number, net: number) => ({
  trade_id: id, sec_type: 'CASH', symbol: 'USD.CNH', currency: 'CNH', side, size,
  price: Math.abs(net / size), net_amount: net, commission: 2, trade_time: '2026-03-31T11:34:16Z',
});
test('FX report includes March 31, deduplicates executions and nets reverse conversions', () => {
  const first = trade('one', 'BUY', 100, -700);
  const report = forexReport({ trades: [first, first, trade('two', 'SELL', 20, 142)] }, 2026, '2026-09-28T00:00:00Z');
  assert.match(report, /返回 2 笔/);
  assert.match(report, /2026\/3\/31/);
  assert.match(report, /累计买入 100 USD，累计卖出 20 USD；相抵净额 80 USD/);
  assert.match(report, /CNH 成交支出净额 558 CNH/);
  assert.match(report, /手续费 2（币种未提供）/);
  assert.match(report, /无法据此统计累计入金本金/);
});
test('FX report refuses missing currency and inconsistent monetary legs', () => {
  assert.throws(() => forexReport({ trades: [trade('bad', 'BUY', 100, 700)] }, 2026, 'now'));
  assert.throws(() => forexReport({ trades: [{ ...trade('bad', 'BUY', 100, -700), currency: 'USD' }] }, 2026, 'now'));
  assert.throws(() => forexReport({ trades: [{ ...trade('bad', 'BUY', 100, -700), price: null }] }, 2026, 'now'));
});
test('FX retrieval requests year-to-date, shares concurrent calls and caches the result', async () => {
  let calls = 0;
  const history = new ForexHistory({ call: async (name, args) => {
    calls++;
    assert.equal(name, 'get_account_trades');
    assert.equal(args?.period, 'YEAR_TO_DATE');
    return { trades: [] };
  } });
  const [a, b] = await Promise.all([history.get(), history.get()]);
  assert.equal(a, b);
  await history.get();
  assert.equal(calls, 1);
});

test('cost comparison uses CNH per USD and the correct return denominator', async () => {
  const { summarizeForex, fxReference, fxCostReport, fxReturnPercent } = await import('../server/forex-calculations.js');
  const summary = summarizeForex({ trades: [trade('buy', 'BUY', 100, -700), trade('sell', 'SELL', 20, 142)] }, 2026);
  assert.equal(summary.buyAverage, 7);
  const quote = fxReference({ 'bid-ask': { bid: 6.85, ask: 6.87 }, 'top-status': { status: 'REALTIME' } }, 1, '2026-09-28T08:00:00Z');
  assert.ok(quote);
  assert.ok(Math.abs(fxReturnPercent(7, quote.rate) + 2) < 1e-10);
  const answer = fxCostReport(summary, quote, '平均成本6.8以上还是以下，亏了百分之多少');
  assert.match(answer, /高于 6.8/);
  assert.match(answer, /-2.00%/);
  assert.match(answer, /当前全部美元资产/);
  const missing = fxCostReport(summary, null);
  assert.match(missing, /没有取得/);
  assert.doesNotMatch(missing, /\d+\.\d+%/);
});
test('frozen, unknown and crossed FX quotes cannot masquerade as a current rate', async () => {
  const { fxReference } = await import('../server/forex-calculations.js');
  for (const status of ['FROZEN', 'UNKNOWN']) assert.equal(fxReference({ 'bid-ask': { bid: 6.7, ask: 6.71 }, 'top-status': { status } }, 1, 'now'), null);
  assert.equal(fxReference({ 'bid-ask': { bid: 7, ask: 6.9 }, 'top-status': { status: 'REALTIME' } }, 1, 'now'), null);
});

test('live FX analysis selects the cash contract, ignores CFD and reuses fresh quotes', async () => {
  const year = new Date().getUTCFullYear();
  let calls = 0;
  const history = new ForexHistory({ call: async (name, args) => {
    calls++;
    if (name === 'get_account_trades') return { trades: [{ ...trade('x', 'BUY', 100, -700), trade_time: year + '-03-31T00:00:00Z' }] };
    if (name === 'search_contracts') {
      assert.equal(args?.query, 'USD.CNH');
      return { results: [
        { symbol: 'USD', exchange: 'BEST', underlying_contract_id: 20, sections: [{ security_type: 'CFD' }] },
        { symbol: 'USD', exchange: 'IDEALPRO', underlying_contract_id: 10, sections: [{ security_type: 'CASH' }] },
      ] };
    }
    assert.equal(name, 'get_price_snapshot');
    assert.equal(args?.contract_id, 10);
    return { 'bid-ask': { bid: 6.85, ask: 6.87 }, 'top-status': { status: 'REALTIME' } };
  } });
  assert.match(await history.analysis('6.8以上还是以下'), /-2.00%/);
  assert.match(await history.analysis('6.8以上还是以下'), /高于 6.8/);
  assert.equal(calls, 3);
});
