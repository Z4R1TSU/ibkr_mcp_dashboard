import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inferCashFlows, withCashFlows } from '../server/cash-flows.js';
import { buildPnlCalendar } from '../server/pnl-calendar.js';
import { normalizeTrades, TradeHistory } from '../server/trades.js';
import { cashFlowMoney } from '../shared/cash-flows.js';
import type { TradesState } from '../shared/trades.js';

const now = new Date('2026-10-23T14:00:00Z');
const fx = (id: string, symbol = 'USD.CNH', side = 'BUY', size = 100, net = -700, time = '2026-09-16T13:20:36Z') => ({
  trade_id: id, symbol, sec_type: 'CASH', side, size, net_amount: net,
  price: Math.abs(net / size), currency: symbol.split('.')[1], trade_time: time, commission: 2,
});
const history = (rows: unknown[]): TradesState => ({
  trades: normalizeTrades({ trades: rows }), range: 'year', startDate: '2026-01-01', endDate: '2026-10-23',
  timeZone: 'America/New_York', fetchedAt: now.toISOString(), refreshing: false, stale: false, error: null,
});

test('funding references normalize both FX orientations, deduplicate, and net reverse conversions', () => {
  const buy = fx('buy');
  const flows = inferCashFlows(history([buy, buy, fx('sell', 'USD.CNH', 'SELL', 20, 140),
    fx('inverse-buy', 'CNH.USD', 'SELL', 70, 10),
    fx('inverse-sell', 'CNH.USD', 'BUY', 35, -5),
    fx('hkd', 'USD.HKD', 'BUY', 1, -7.8)]));
  assert.equal(flows.records.length, 5);
  assert.deepEqual(flows.totals, { deposits: 111, withdrawals: 25, net: 86 });
  const reverse = flows.records.find(row => row.id === 'inverse-buy')!;
  assert.equal(reverse.direction, 'deposit');
  assert.equal(reverse.amount, 10);
  assert.equal(reverse.counterCurrency, 'CNH');
  assert.equal(reverse.counterAmount, 70);
  assert.equal(flows.records.find(row => row.id === 'inverse-sell')!.direction, 'withdrawal');
  assert.equal(flows.records.find(row => row.id === 'hkd')!.counterCurrency, 'HKD');
});

test('small balances remain precise and New York dates, including weekends, are preserved', () => {
  const flows = inferCashFlows(history([fx('tiny', 'CNH.USD', 'SELL', 0.0130125, 0.0019416, '2026-09-19T01:42:48Z'),
    fx('weekend', 'USD.CNH', 'BUY', 100, -700, '2026-09-19T14:00:00Z')]));
  assert.equal(flows.records.find(row => row.id === 'tiny')!.date, '2026-09-18');
  assert.equal(flows.totals.deposits, 100.0019416);
  assert.equal(cashFlowMoney(0.0019416), '0.0019416');
  const original = buildPnlCalendar('2026-09', 'USD', [], undefined, now);
  const calendar = withCashFlows(original, flows);
  assert.equal(calendar.days[18].status, 'closed');
  assert.equal(calendar.days[18].cashFlows![0].id, 'weekend');
  assert.equal(calendar.days[18].pnl, null);
  assert.equal(calendar.days[17].status, 'missing');
  assert.equal(calendar.days[17].cashFlows![0].id, 'tiny');
  assert.deepEqual(calendar.summary, original.summary);
});

test('unsupported pairs and inconsistent or incomplete FX cannot become funding amounts', () => {
  const flows = inferCashFlows(history([
    { ...fx('stock'), sec_type: 'STK' }, fx('other', 'EUR.CNH'),
    fx('sign', 'USD.CNH', 'BUY', 100, 700), { ...fx('size'), size: null },
    { ...fx('price'), price: 0 }, { ...fx('currency'), currency: 'USD' },
    fx('direction', 'USD.CNH', 'UNKNOWN'), fx('good'),
  ]));
  assert.equal(flows.skipped, 6);
  assert.equal(flows.records.length, 1);
  assert.equal(flows.totals.net, 100);
});

test('calendar augments FX days without changing P&L, TWR, or no-flow days and months', () => {
  const original = buildPnlCalendar('2026-09', 'USD', [{ date: '2026-09-16', previousDate: '2026-09-15',
    startNav: 1000, endNav: 1010, returnPct: 1, source: 'ib-pa', fetchedAt: now.toISOString() }], undefined, now);
  assert.equal(withCashFlows(original, inferCashFlows(history([]))), original);
  const flows = inferCashFlows(history([fx('buy'), fx('sell', 'USD.CNH', 'SELL', 20, 140),
    fx('older', 'USD.CNH', 'BUY', 50, -350, '2026-03-31T14:00:00Z')]));
  const calendar = withCashFlows(original, flows);
  assert.equal(calendar.days[15].cashFlows!.length, 2);
  assert.equal(calendar.days[15].pnl, 10);
  assert.equal(calendar.days[15].returnPct, 1);
  assert.equal(calendar.days[14], original.days[14]);
  assert.deepEqual(calendar.summary, original.summary);
  assert.equal(calendar.earliestDate, '2026-03-31');
  assert.deepEqual(calendar.cashFlows!.totals, { deposits: 100, withdrawals: 20, net: 80 });
  const emptyMonth = buildPnlCalendar('2026-10', 'USD', [], undefined, now);
  const decorated = withCashFlows(emptyMonth, flows);
  assert.equal(decorated.cashFlows, undefined);
  assert.deepEqual(decorated.days, emptyMonth.days);
  assert.deepEqual(decorated.summary, emptyMonth.summary);
});

test('funding uses annual caches, survives restart/failure, and retains saved prior years', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-flows-'));
  let clock = now.getTime(), fail = false, calls = 0;
  const client = { call: async (_name: string, args?: Record<string, unknown>) => {
    assert.equal(args?.period, 'YEAR_TO_DATE'); calls++;
    if (fail) throw new Error('offline');
    return { trades: [fx('current')] };
  } };
  try {
    fs.writeFileSync(path.join(directory, 'trades.json'), JSON.stringify({ version: 2, caches: {
      'year:2025': { fetchedAt: '2025-12-31T23:00:00Z', trades: normalizeTrades({ trades: [fx('old', 'USD.CNH', 'BUY', 50, -350, '2025-03-31T14:00:00Z')] }) },
    } }));
    const store = new TradeHistory(client, directory, () => clock);
    await store.refresh(false, 'year');
    const initial = inferCashFlows(store.yearHistory());
    assert.equal(initial.records.length, 2);
    assert.equal(initial.startDate, '2025-01-01');
    assert.equal(initial.totals.net, 150);
    const restored = new TradeHistory(client, directory, () => clock);
    assert.deepEqual(inferCashFlows(restored.yearHistory()), initial);
    clock += 301000; fail = true;
    await restored.refresh(false, 'year');
    const stale = inferCashFlows(restored.yearHistory());
    assert.equal(calls, 2);
    assert.equal(stale.stale, true);
    assert.ok(stale.error);
    assert.deepEqual(stale.records, initial.records);
    assert.equal(stale.fetchedAt, initial.fetchedAt);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('average FX rates use monetary weights, normalize inverse pairs, and separate currencies and directions', () => {
  const flows = inferCashFlows(history([
    fx('buy', 'USD.CNH', 'BUY', 100, -600),
    fx('inverse-buy', 'CNH.USD', 'SELL', 2400, 300),
    fx('sell', 'USD.CNH', 'SELL', 20, 150),
    fx('inverse-sell', 'CNH.USD', 'BUY', 70, -10),
    fx('hkd', 'USD.HKD', 'BUY', 10, -78.3595),
  ]));
  const [cnh, hkd] = flows.exchangeRates;
  assert.equal(cnh.currency, 'CNH');
  assert.equal(cnh.depositRate, 7.5, 'weighted rate differs from the arithmetic mean of 6 and 8');
  assert.ok(Math.abs(cnh.withdrawalRate! - 220 / 30) < 1e-12);
  assert.equal(hkd.currency, 'HKD');
  assert.ok(Math.abs(hkd.depositRate! - 7.83595) < 1e-12);
  assert.equal(hkd.withdrawalRate, null);
  assert.deepEqual(inferCashFlows(history([])).exchangeRates, []);
  const onlySell = inferCashFlows(history([fx('sell', 'USD.CNH', 'SELL', 10, 70)]));
  assert.equal(onlySell.exchangeRates[0].depositRate, null);
});

test('calendar exchange averages use only the selected month and keep fractional-cent amounts', () => {
  const flows = inferCashFlows(history([
    fx('older', 'USD.CNH', 'BUY', 100, -800, '2026-03-31T14:00:00Z'),
    fx('small', 'CNH.USD', 'SELL', 0.013, 0.002),
  ]));
  const calendar = withCashFlows(buildPnlCalendar('2026-09', 'USD', [], undefined, now), flows);
  assert.ok(Math.abs(calendar.cashFlows!.exchangeRates[0].depositRate! - 6.5) < 1e-12);
  assert.ok(flows.exchangeRates[0].depositRate! > 7.99);
});
