import test from 'node:test';
import assert from 'node:assert/strict';
import { isUsEquityTradingDate, previousUsEquityTradingDate } from '../server/us-market-calendar.js';
import { completedDay } from '../server/daily-performance.js';
import { latestPerformanceTradingDate } from '../server/discord/performance.js';

test('previous trading date skips weekends, holidays and exceptional closures', () => {
  for (const [date, previous] of [
    ['2026-10-11', '2026-10-09'], ['2026-10-12', '2026-10-09'],
    ['2026-09-08', '2026-09-04'], ['2026-01-20', '2026-01-16'],
    ['2026-01-02', '2025-12-31'], ['2025-01-10', '2025-01-08'],
  ]) assert.equal(previousUsEquityTradingDate(date), previous);
  assert.throws(() => previousUsEquityTradingDate('2026-02-30'));
});

test('US equity calendar excludes exchange holidays, not all federal holidays', () => {
  for (const date of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
    '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25', '2026-10-10', '2026-10-11', '2025-01-09']) {
    assert.equal(isUsEquityTradingDate(date), false, date);
  }
  for (const date of ['2026-10-09', '2026-10-12', '2026-11-11', '2021-12-31', '2021-06-18', '2026-11-27']) {
    assert.equal(isUsEquityTradingDate(date), true, date);
  }
  for (const date of ['2026-02-30', 'bad', '2026-2-3']) assert.equal(isUsEquityTradingDate(date), false);
});

test('a current valuation is not completed equity-session performance before market close', () => {
  const morning = new Date('2026-10-12T04:00:00Z');
  assert.equal(completedDay('2026-10-09', morning), true);
  for (const date of ['2026-10-10', '2026-10-11', '2026-10-12']) assert.equal(completedDay(date, morning), false);
  assert.equal(completedDay('2026-10-12', new Date('2026-10-12T19:59:00Z')), false);
  assert.equal(completedDay('2026-10-12', new Date('2026-10-12T20:01:00Z')), true);
});

test('presence chooses an available trading date bounded by observed sessions', () => {
  const morning = new Date('2026-10-12T04:00:00Z');
  const raw = { accounts: { account: { periods: { LOCAL: { frequency: 'D',
    dates: ['20261008', '20261009', '20261010', '20261011', '20261012'] } } } },
    local_archive: { latestDate: '2026-10-11' } };
  assert.equal(latestPerformanceTradingDate(raw, '2026-10-09', morning), '2026-10-09');
  assert.equal(latestPerformanceTradingDate(raw, null, morning), '2026-10-09');
  const closed = new Date('2026-10-12T21:00:00Z');
  assert.equal(latestPerformanceTradingDate(raw, '2026-10-09', closed), '2026-10-09');
  assert.equal(latestPerformanceTradingDate(raw, '2026-10-12', closed), '2026-10-12');
  raw.accounts.account.periods.LOCAL.dates = ['20261008'];
  assert.equal(latestPerformanceTradingDate(raw, '2026-10-09', morning), '2026-10-08');
  raw.accounts.account.periods.LOCAL.dates = ['20261010', '20261011'];
  assert.equal(latestPerformanceTradingDate(raw, null, morning), null);
});
