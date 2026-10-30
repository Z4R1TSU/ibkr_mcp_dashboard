import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PerformanceStore } from '../server/performance-store.js';
import { PerformanceSource } from '../server/performance-source.js';
import { FrozenPresenceStore } from '../server/discord/frozen.js';
import { buildPnlCalendar } from '../server/pnl-calendar.js';
import type { DailyFacts } from '../server/daily-data.js';

const now = new Date('2026-10-16T22:00:00Z');
test('sealed local days outrank saved reports and broker revisions, including after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-local-'));
  try {
    const store = new PerformanceStore(dir), snapshots = new FrozenPresenceStore(dir);
    store.ingest(broker(), now);
    const observed = new Date('2026-10-13T03:00:00Z');
    snapshots.recordReport({ ...facts('2026-10-12', '2026-10-09', 1), generatedAt: observed.toISOString() }, observed);
    const folder = path.join(dir, 'daily-reports');
    fs.mkdirSync(folder);
    const report = (value: DailyFacts) => fs.writeFileSync(path.join(folder, value.date + '.json'), JSON.stringify({ facts: value }));
    report(facts('2026-10-12', '2026-10-09', 7));
    report(facts('2026-10-13', '2026-10-12', 3));
    report({ ...facts('2026-10-14', '2026-10-13', 8), accountId: 'foreign' });
    const first = store.calendar('2026-10', now, snapshots);
    assert.equal(first.days[11].pnl, 10);
    assert.equal(first.days[11].returnPct, 1);
    assert.equal(first.days[11].source, 'local-snapshot');
    assert.equal(first.days[12].pnl, 30);
    assert.equal(first.days[12].source, 'daily-report');
    assert.equal(first.days[13].source, 'ib-pa');
    assert.equal(first.days[14].source, 'ib-pa');
    store.ingest(broker('one', 4), now);
    assert.equal(store.calendar('2026-10', now, snapshots).days[11].pnl, 10);
    const restarted = new PerformanceStore(dir).calendar('2026-10', now, new FrozenPresenceStore(dir));
    assert.equal(restarted.days[11].pnl, 10);
    assert.equal(restarted.days[12].pnl, 30);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'performance-history.json'), 'utf8')).days['2026-10-12'].endNav, 1040);
    report(facts('2026-10-15', '2026-10-14', 5));
    const source = new PerformanceSource({ call: async () => broker() }, dir, snapshots);
    assert.equal(source.calendar('2026-10', now).days[14].pnl, 50);
    store.ingest(broker('new-account'), now);
    assert.ok(store.calendar('2026-10', now, snapshots).days.filter(d => d.status === 'available').every(d => d.source === 'ib-pa'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
function broker(id = 'one', rate = 2) {
  return { portfolio_measure: 'TWR', accounts: { [id]: { base_currency: 'USD', periods: {
    '7D': { frequency: 'D', start_date: '20261009', start_nav: 1000,
      dates: ['20261012', '20261013', '20261014', '20261015'],
      nav: [1, 2, 3, 4].map(i => 1000 * (1 + rate / 100) ** i),
      cps: [1, 2, 3, 4].map(i => (1 + rate / 100) ** i - 1) },
  } } } };
}

test('local rows retain their own NAV pair and final status when IB supplies a newer observation', () => {
  const local = { date: '2026-10-16', previousDate: '2026-10-15', startNav: 1000, endNav: 1100,
    returnPct: 10, fetchedAt: '2026-10-16T21:00:00Z', source: 'local-snapshot' as const };
  const current = { ...local, currency: 'USD', endNav: 1020, returnPct: 2, navChange: 20,
    flowMismatch: false, measure: 'TWR', asOf: now.toISOString() };
  const data = buildPnlCalendar('2026-10', 'USD', [local], current, now);
  assert.equal(data.days[15].pnl, 100);
  assert.equal(data.days[15].provisional, false);
  assert.equal(data.days[15].asOf, local.fetchedAt);
  const mismatch = buildPnlCalendar('2026-10', 'USD', [{ ...local, endNav: 2000 }], current, now);
  assert.equal(mismatch.days[15].pnl, null);
  assert.equal(mismatch.days[15].returnPct, 10);
  assert.equal(mismatch.days[15].issue, 'cash-flow');
});

test('legacy sealed days get their session date and currency-mismatched reports cannot override IB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-local-legacy-'));
  try {
    const store = new PerformanceStore(dir);
    store.ingest(broker(), now);
    fs.writeFileSync(path.join(dir, 'discord-daily-snapshots.json'), JSON.stringify({ version: 1, records: [
      { scope: JSON.stringify(['one', 'USD']), day: { date: '2026-10-12', currency: 'USD', startNav: 1000,
        endNav: 900, returnPct: -10, sourceFetchedAt: '2026-10-13T03:00:00Z', capturedAt: '2026-10-13T04:00:00Z' } },
    ] }));
    fs.mkdirSync(path.join(dir, 'daily-reports'));
    const report = facts('2026-10-13', '2026-10-12', 3);
    report.account.currency = 'HKD';
    fs.writeFileSync(path.join(dir, 'daily-reports', '2026-10-13.json'), JSON.stringify({ facts: report }));
    const data = store.calendar('2026-10', now, new FrozenPresenceStore(dir));
    assert.equal(data.days[11].pnl, -100);
    assert.equal(data.days[11].previousDate, '2026-10-09');
    assert.equal(data.days[12].source, 'ib-pa');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
function facts(date: string, previousDate: string, rate: number): DailyFacts {
  return { date, accountId: 'one', generatedAt: now.toISOString(), benchmarks: [], holdings: [], warnings: [],
    account: { date, previousDate, currency: 'USD', startNav: 1000, endNav: 1000 + rate * 10,
      returnPct: rate, navChange: rate * 10, flowMismatch: false, measure: 'TWR' } };
}
