import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrades } from '../server/trades.js';
import { annotateTrades, enrichOrderTypes, optionRight } from '../server/trade-options.js';
import { tradeType } from '../shared/trades.js';

const raw = (id: string, order: number) => ({ trade_id: id, trade_time: '2026-10-13T17:56:44Z', symbol: 'TEST', sec_type: 'OPT', side: 'SELL', order_id: order });
test('option types require contract data and never follow direction or underlying name', () => {
  assert.equal(optionRight('TEST 261016P00100000'), 'P');
  assert.equal(optionRight("Sell 1 TEST OCT 16 '26 100 Call"), 'C');
  assert.equal(optionRight('Put / Call combo'), null);
  assert.equal(optionRight('20 Limit, Day'), null);
  const unknown = normalizeTrades({ trades: [{ ...raw('one', 1), symbol: 'CALL' }] })[0];
  assert.equal(unknown.optionRight, null);
  assert.match(tradeType(unknown), /Put\/Call 未提供/);
  const put = normalizeTrades({ trades: [{ ...raw('two', 2), option_right: 'PUT' }] })[0];
  assert.equal(tradeType(put), '卖出 Put');
  assert.equal(put.optionSource, 'trade');
});

test('orders match by ID, symbol and side before assigning Put or Call', () => {
  const trades = normalizeTrades({ trades: [raw('one', 1), raw('two', 2)] });
  const orders = { orders: [{ order_id: 1, side: 'SELL', primary_description: "Sell 1 TEST OCT 16 '26 100 Call" }] };
  const enriched = enrichOrderTypes(trades, orders);
  assert.equal(enriched[0].optionRight, 'C');
  assert.equal(enriched[0].optionSource, 'order');
  assert.equal(enriched[1].optionRight, null);
  orders.orders[0].side = 'BUY';
  assert.equal(enrichOrderTypes(trades, orders)[0].optionRight, null);
});

test('user confirmations apply to one exact trade and remain distinct from broker data', () => {
  const trades = normalizeTrades({ trades: [raw('one', 1), raw('two', 2)] });
  const annotations = { one: { symbol: 'TEST', time: trades[0].time, side: 'SELL', right: 'P' as const } };
  const confirmed = annotateTrades(trades, annotations);
  assert.equal(confirmed[0].optionRight, 'P');
  assert.equal(confirmed[0].optionSource, 'user');
  assert.equal(confirmed[1].optionRight, null);
  assert.equal(tradeType(confirmed[0]), '卖出 Put');
  annotations.one.time = '2026-10-12T17:56:44.000Z';
  assert.equal(annotateTrades(trades, annotations)[0].optionRight, null);
  const fromBroker = { ...trades[0], optionRight: 'C' as const, optionSource: 'trade' as const };
  assert.equal(annotateTrades([fromBroker], { one: { ...annotations.one, time: fromBroker.time } })[0].optionRight, 'C');
});
