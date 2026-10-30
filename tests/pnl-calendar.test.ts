import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import type { Collector } from '../server/collector.js';
import type { IbkrClient } from '../server/ibkr.js';
import { buildPnlCalendar } from '../server/pnl-calendar.js';
import { PerformanceStore, type PerformanceDay } from '../server/performance-store.js';
import { calendarDates, isCalendarMonth, shiftCalendarMonth } from '../shared/pnl-calendar.js';
import { isUsEquityTradingDate, previousUsEquityTradingDate } from '../server/us-market-calendar.js';

const now = new Date('2026-10-16T14:00:00Z');
test('calendar API requires login, validates months and reads shared history without IB requests', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-api-'));
  let reads = 0;
  const client = { oauth: { vault: { directory, checkPassword: () => true } },
    call: async () => { throw new Error('Unexpected IB request'); } } as unknown as IbkrClient;
  const performance = { calendar: (month: string, time = new Date()) => {
    reads++;
    return buildPnlCalendar(month, 'USD', [row('2026-09-01')], undefined, time);
  } };
  const app = createApp(client, new EventEmitter() as Collector, { ...config, accessMode: 'password' },
    undefined, undefined, undefined, performance);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  try {
    assert.equal((await fetch(base + '/api/pnl-calendar')).status, 401);
    assert.equal(reads, 0);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: new URL(config.publicUrl).origin } });
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0] };
    for (const month of ['2026-13', '2026-2', '2199-01', '2026-10&month=2026-09']) {
      assert.equal((await fetch(base + '/api/pnl-calendar?month=' + month, { headers })).status, 400);
    }
    assert.equal(reads, 0);
    const response = await fetch(base + '/api/pnl-calendar?month=2026-09', { headers });
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.month, '2026-09');
    assert.equal(data.days[0].pnl, 10);
    assert.equal(reads, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true });
  }
});
test('today uses its own timestamp and scope; yesterday is never carried forward', () => {
  const current = { ...row('2026-10-16'), currency: 'USD', navChange: 10, flowMismatch: false,
    measure: 'TWR', asOf: now.toISOString() };
  const view = (value = current) => buildPnlCalendar('2026-10', 'USD', [], value, now);
  assert.equal(view().days[15].pnl, 10);
  assert.equal(view().days[15].provisional, true);
  assert.equal(view().days[15].asOf, current.asOf);
  assert.equal(view({ ...current, date: '2026-10-15' }).days[15].pnl, null);
  assert.equal(view({ ...current, currency: 'HKD' }).days[15].pnl, null);
  assert.equal(view({ ...current, asOf: '2026-10-16T07:59:00Z' }).days[15].pnl, null);
  assert.equal(view({ ...current, asOf: '2026-10-17T14:00:00Z' }).days[15].pnl, null);
  const older = { ...current, asOf: '2026-10-16T13:00:00Z' };
  const stale = view(older).days[15];
  assert.equal(stale.pnl, 10);
  assert.equal(stale.asOf, older.asOf);
});

test('calendar retains records before archive gaps, restarts, and same-day broker revisions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-calendar-'));
  try {
    const rows = [row('2026-09-01'), row('2026-10-15')];
    fs.writeFileSync(path.join(directory, 'performance-history.json'), JSON.stringify({
      version: 1, accountId: 'PRIVATE-FIXTURE', currency: 'USD',
      days: Object.fromEntries(rows.map(day => [day.date, day])),
    }));
    const store = new PerformanceStore(directory);
    assert.equal(store.calendar('2026-09', now).days[0].pnl, 10);
    assert.equal(store.calendar('2026-10', now).earliestDate, '2026-09-01');
    assert.equal(store.calendar('2026-10', now).days[14].pnl, 10);
    assert.doesNotMatch(JSON.stringify(store.calendar('2026-10', now)), /PRIVATE-FIXTURE|accountId/);
    store.ingest({ portfolio_measure: 'TWR', accounts: { 'PRIVATE-FIXTURE': { base_currency: 'USD', periods: {
      '1D': { frequency: 'D', start_date: '20261014', start_nav: 1000, dates: ['20261015'], nav: [990], cps: [-0.01] },
    } } } }, now);
    assert.equal(new PerformanceStore(directory).calendar('2026-10', now).days[14].pnl, -10);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
test('monthly totals compound daily returns and never fill gaps with zero', () => {
  let nav = 1000;
  const rows = calendarDates('2026-09').filter(isUsEquityTradingDate).map((date, i) => {
    const day = row(date, nav, i === 0 ? 10 : i === 1 ? -10 : 0);
    nav = day.endNav;
    return day;
  });
  const full = buildPnlCalendar('2026-09', 'USD', rows, undefined, now);
  assert.equal(full.summary.pnl, -10);
  assert.ok(Math.abs(full.summary.returnPct! + 1) < 1e-9);
  assert.equal(full.summary.profitDays, 1);
  assert.equal(full.summary.lossDays, 1);
  assert.equal(full.summary.recordedDays, full.summary.expectedDays);
  const partial = buildPnlCalendar('2026-09', 'USD', rows.slice(1), undefined, now);
  assert.equal(partial.days[0].pnl, null);
  assert.equal(partial.summary.pnl, -110);
  assert.equal(partial.summary.returnPct, null);
  assert.equal(partial.summary.flatDays, rows.length - 2);
});

test('deposits and multi-session intervals cannot become daily P&L', () => {
  const deposit = { ...row('2026-10-01'), endNav: 2010 };
  const gap = { ...row('2026-10-05'), previousDate: '2026-10-01' };
  const data = buildPnlCalendar('2026-10', 'USD', [deposit, gap], undefined, now);
  assert.equal(data.days[0].pnl, null);
  assert.equal(data.days[0].returnPct, 1);
  assert.equal(data.days[0].issue, 'cash-flow');
  assert.equal(data.days[4].pnl, null);
  assert.equal(data.days[4].returnPct, null);
  assert.equal(data.days[4].issue, 'date-gap');
  assert.equal(data.summary.pnl, null);
  assert.equal(data.summary.amountDays, 0);
});
function row(date: string, startNav = 1000, returnPct = 1): PerformanceDay {
  return { date, previousDate: previousUsEquityTradingDate(date), startNav,
    endNav: startNav * (1 + returnPct / 100), returnPct, source: 'ib-pa',
    fetchedAt: now.toISOString() };
}

test('MTD ends at the latest valuation instead of requiring today, but cannot cross a missing session', () => {
  const dates = calendarDates('2026-10').filter(date => date <= '2026-10-15' && isUsEquityTradingDate(date));
  const rows = dates.map(date => row(date));
  const mtd = buildPnlCalendar('2026-10', 'USD', rows, undefined, now);
  assert.equal(mtd.days[15].status, 'missing');
  assert.equal(mtd.summary.returnThroughDate, '2026-10-15');
  assert.ok(Math.abs(mtd.summary.returnPct! - (1.01 ** rows.length - 1) * 100) < 1e-8);
  for (const missing of [0, 4]) {
    const gap = buildPnlCalendar('2026-10', 'USD', rows.filter((_, i) => i !== missing), undefined, now);
    assert.equal(gap.summary.returnPct, null);
    assert.equal(gap.summary.returnThroughDate, null);
  }
});

test('calendar respects leap years, year boundaries, New York dates and US holidays', () => {
  assert.equal(calendarDates('2024-02').length, 29);
  assert.equal(calendarDates('2025-02').length, 28);
  assert.equal(shiftCalendarMonth('2026-01', -1), '2025-12');
  assert.equal(shiftCalendarMonth('2025-12', 1), '2026-01');
  for (const value of ['2026-00', '2026-13', '2026-2', '2026-02-01', [], null]) assert.equal(isCalendarMonth(value), false);
  const data = buildPnlCalendar('2026-07', 'USD', [], undefined, new Date('2026-07-07T01:00:00Z'));
  assert.equal(data.today, '2026-07-06');
  assert.equal(data.days[2].status, 'closed');
  assert.equal(data.days[3].status, 'closed');
  assert.equal(data.days[5].status, 'missing');
  assert.equal(data.days[6].status, 'future');
  assert.equal(data.summary.expectedDays, 3);
  assert.equal(data.summary.pnl, null);
  assert.equal(data.summary.returnPct, null);
});
