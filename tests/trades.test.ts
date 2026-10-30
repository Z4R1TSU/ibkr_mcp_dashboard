import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tradeWindow } from '../server/trade-ranges.js';
import { normalizeTrades, TradeHistory } from '../server/trades.js';
import { filterTrades, tradeClock, tradeDate } from '../shared/trades.js';

const row = (id: string, time = '2026-10-13T14:47:19Z') => ({ trade_id: id, trade_time: time, symbol: 'TEST', sec_type: 'STK', side: 'BUY', size: 2, price: 10, currency: 'USD', net_amount: -20, commission: 0 });

test('trades deduplicate IDs, sort by actual time, and preserve unknown amounts', () => {
  const trades = normalizeTrades({ trades: [row('one'), row('two', '2026-10-13T17:56:44Z'), { ...row('one'), price: 12, size: null, commission: undefined }] });
  assert.deepEqual(trades.map(t => t.id), ['two', 'one']);
  assert.equal(trades[0].commission, 0);
  assert.equal(trades[1].price, 12);
  assert.equal(trades[1].size, null);
  assert.equal(trades[1].commission, null);
  for (const raw of [{}, { trades: [row('')] }, { trades: [row('a', '2026-10-13T12:00:00')] }, { trades: [row('a', 'invalid')] }]) assert.throws(() => normalizeTrades(raw));
  assert.deepEqual(normalizeTrades({ trades: [] }), []);
});

test('Beijing midnight does not split a US trading day; repeated DST hours are distinct', () => {
  assert.equal(tradeDate('2026-10-13T14:47:19Z'), '2026-10-13');
  assert.equal(tradeDate('2026-10-13T17:56:44Z'), '2026-10-13');
  assert.equal(tradeClock('2026-10-13T17:56:44Z'), '13:56:44 EDT');
  assert.equal(tradeClock('2026-11-01T05:30:00Z'), '01:30:00 EDT');
  assert.equal(tradeClock('2026-11-01T06:30:00Z'), '01:30:00 EST');
});

test('30-day window follows New York dates across New Year and DST, excluding future trades', () => {
  for (const [now, start] of [
    ['2027-01-01T02:00:00Z', '2026-12-02T05:00:00Z'],
    ['2026-11-02T05:30:00Z', '2026-10-04T04:00:00Z'],
  ]) {
    const time = Date.parse(now);
    const trades = normalizeTrades({ trades: [
      row('start', start), row('before', new Date(Date.parse(start) - 1000).toISOString()),
      row('now', now), row('future', new Date(time + 1000).toISOString()),
    ] });
    const window = tradeWindow('30d', time);
    assert.deepEqual(filterTrades(trades, time, window.startDate, window.endDate).map(t => t.id), ['now', 'start']);
  }
});

test('nonblocking cached reads survive failures and restart; successful empty results replace old data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-trades-'));
  // 10:00 New York, a trading session: the five-minute cache applies.
  let now = Date.parse('2026-10-14T14:00:00Z'), calls = 0, fail = false;
  let rows = [row('one')];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = { call: async (name: string, args?: Record<string, unknown>) => {
    calls++;
    assert.equal(name, 'get_account_trades');
    assert.equal(args?.period, 'DAYS_60');
    await gate;
    if (fail) throw new Error('Upstream failed');
    return { trades: rows };
  } };
  const history = new TradeHistory(client, directory, () => now);
  try {
    assert.equal(history.read().refreshing, true);
    const pending = history.refresh();
    assert.equal(history.refresh(true), pending);
    release(); await pending;
    const initial = history.view();
    assert.equal(initial.stale, false);
    assert.equal(initial.trades.length, 1);
    assert.equal(fs.statSync(path.join(directory, 'trades.json')).mode & 0o777, 0o600);
    await history.refresh();
    const restored = new TradeHistory(client, directory, () => now);
    assert.deepEqual(restored.read(), initial);
    assert.equal(calls, 1);
    now += 301000; fail = true;
    await history.refresh();
    assert.equal(history.view().stale, true);
    assert.ok(history.view().error);
    assert.equal(history.view().fetchedAt, initial.fetchedAt);
    assert.deepEqual(history.view().trades, initial.trades);
    history.read(); await history.refresh(true);
    assert.equal(calls, 2);
    now += 61000; fail = false; rows = [];
    await history.refresh();
    assert.equal(history.view().stale, false);
    assert.equal(history.view().error, null);
    assert.deepEqual(history.view().trades, []);
    assert.equal(calls, 3);
  } finally {
    release(); await history.refresh();
    fs.rmSync(directory, { recursive: true });
  }
});

test('a closed market keeps the last trades until the next shared slot instead of re-reading every five minutes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-trades-closed-'));
  // Saturday 2026-10-17 13:00 UTC; the next six-hour slot is 18:00 UTC.
  let now = Date.parse('2026-10-17T13:00:00Z'), calls = 0;
  const client = { call: async () => { calls++; return { trades: [row('one')] }; } };
  const history = new TradeHistory(client, directory, () => now);
  try {
    await history.refresh();
    assert.equal(calls, 1);
    now += 3 * 3600000;
    history.read(); await history.refresh();
    assert.equal(calls, 1);
    assert.equal(history.view().stale, false);
    now = Date.parse('2026-10-17T18:00:00Z');
    assert.equal(history.view().stale, true);
    await history.refresh();
    assert.equal(calls, 2);
    await history.refresh(true);
    assert.equal(calls, 2, 'forced refreshes are still rate limited');
  } finally { fs.rmSync(directory, { recursive: true }); }
});
