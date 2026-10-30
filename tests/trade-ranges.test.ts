import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tradeWindow } from '../server/trade-ranges.js';
import { TradeHistory } from '../server/trades.js';
import { isTradeRange } from '../shared/trades.js';

const row = (id: string, time: string) => ({ trade_id: id, trade_time: time, symbol: 'TEST', sec_type: 'STK' });
test('default date skips US weekends and holidays; ranges use New York dates', () => {
  for (const [now, expected] of [
    ['2026-10-14T08:00:00Z', '2026-10-13'],
    ['2026-10-12T12:00:00Z', '2026-10-09'],
    ['2026-12-28T12:00:00Z', '2026-12-24'],
  ]) {
    const w = tradeWindow('previous', Date.parse(now));
    assert.equal(w.startDate, expected); assert.equal(w.endDate, expected);
  }
  const now = Date.parse('2027-01-01T02:00:00Z');
  assert.equal(tradeWindow('today', now).startDate, '2026-12-31');
  assert.equal(tradeWindow('7d', now).startDate, '2026-12-25');
  assert.equal(tradeWindow('month', now).startDate, '2026-12-01');
  const year = tradeWindow('year', now);
  assert.equal(year.startDate, '2026-01-01');
  assert.equal(year.periods.length, 5);
  assert.equal(year.key, 'year:2026');
  assert.deepEqual(tradeWindow('year', now + 4 * 3600000).periods, ['YEAR_TO_DATE']);
  for (const invalid of ['constructor', '__proto__', 'ALL', ['year'], null]) assert.equal(isTradeRange(invalid), false);
});

test('annual queries have separate complete caches and never masquerade as recent history', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-trade-ranges-'));
  let now = Date.parse('2026-10-14T08:00:00Z'), failYear = true;
  const periods: unknown[] = [];
  const recent = row('recent', '2026-10-13T14:00:00Z'), old = row('old', '2026-03-01T14:00:00Z');
  const client = { call: async (_name: string, args?: Record<string, unknown>) => {
    periods.push(args?.period);
    if (args?.period === 'YEAR_TO_DATE' && failYear) throw new Error('Year unavailable');
    return { trades: args?.period === 'YEAR_TO_DATE' ? [old, recent] : [recent] };
  } };
  try {
    const history = new TradeHistory(client, directory, () => now);
    await history.refresh();
    assert.equal(history.view().range, 'previous');
    assert.equal(history.view().trades.length, 1);
    assert.equal(history.view('year').fetchedAt, null);
    await history.refresh(false, 'year');
    assert.ok(history.view('year').error);
    assert.equal(history.view('year').fetchedAt, null);
    assert.deepEqual(history.view('year').trades, []);
    assert.equal(history.view().error, null);
    now += 61000; failYear = false;
    await history.refresh(true, 'year');
    assert.equal(history.view('year').trades.length, 2);
    history.read('7d');
    assert.deepEqual(periods, ['DAYS_60', 'YEAR_TO_DATE', 'YEAR_TO_DATE']);
    const restored = new TradeHistory(client, directory, () => now);
    assert.deepEqual(restored.view('year'), history.view('year'));
    assert.equal(restored.view().trades.length, 1);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('legacy recent caches retain exact user confirmations without becoming annual coverage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-trade-legacy-'));
  const time = '2026-10-13T17:56:44.000Z', now = Date.parse('2026-10-14T08:00:00Z');
  try {
    fs.writeFileSync(path.join(directory, 'trades.json'), JSON.stringify({ version: 1, fetchedAt: new Date(now).toISOString(),
      trades: [{ id: 'one', time, symbol: 'TEST', assetClass: 'OPT', side: 'SELL' }] }));
    fs.writeFileSync(path.join(directory, 'trade-annotations.json'), JSON.stringify({
      one: { time, symbol: 'TEST', side: 'SELL', right: 'P' },
    }));
    const history = new TradeHistory({ call: async () => { throw new Error('Unexpected call'); } }, directory, () => now);
    const trade = history.read().trades[0];
    assert.equal(trade.optionRight, 'P');
    assert.equal(trade.optionSource, 'user');
    assert.equal(trade.price, null);
    assert.equal(history.view('year').fetchedAt, null);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('broker option types survive restart and missing order details do not hide trades', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-trade-details-'));
  let now = Date.parse('2026-10-14T08:00:00Z'), failDetails = false;
  const one = { ...row('one', '2026-10-13T14:00:00Z'), sec_type: 'OPT', side: 'SELL', order_id: 1 };
  const client = { call: async (name: string) => {
    if (name === 'get_account_trades') return { trades: failDetails ? [one, { ...one, trade_id: 'two', order_id: 2 }] : [one] };
    if (failDetails) throw new Error('Order details unavailable');
    return { orders: [{ order_id: 1, side: 'SELL', primary_description: "Sell 1 TEST OCT 16 '26 100 Put" }] };
  } };
  try {
    const history = new TradeHistory(client, directory, () => now);
    await history.refresh();
    assert.equal(history.view().trades[0].optionRight, 'P');
    now += 301000; failDetails = true;
    const restored = new TradeHistory(client, directory, () => now);
    assert.equal(restored.view().trades[0].optionSource, 'order');
    await restored.refresh();
    const state = restored.view();
    assert.equal(state.error, null);
    assert.equal(state.trades.length, 2);
    assert.equal(state.trades.find(t => t.id === 'one')?.optionRight, 'P');
    assert.equal(state.trades.find(t => t.id === 'two')?.optionRight, null);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
