import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrozenPresenceStore, dailyCutoff } from '../server/discord/frozen.js';
import { DailyReports } from '../server/daily-report.js';
import type { DailyFacts } from '../server/daily-data.js';
import type { AccountModel } from '../server/bot/model.js';

const time = (hour: string) => new Date('2026-10-13T' + hour + ':00Z');
const facts = (at: Date, rate = -3.58): DailyFacts => ({
  date: '2026-10-12', accountId: 'one', generatedAt: at.toISOString(), benchmarks: [], holdings: [], warnings: [],
  account: { date: '2026-10-12', previousDate: '2026-10-09', currency: 'USD', startNav: 1000,
    endNav: 1000 + rate * 10, navChange: rate * 10, returnPct: rate, flowMismatch: false, measure: 'TWR' },
});
const raw = (at: Date, rate = -2.82, date = '2026-10-12') => ({
  portfolio_measure: 'TWR', accounts: { one: { base_currency: 'USD' } },
  local_archive: { closingDays: [{ date, previousDate: '2026-10-09', startNav: 1000,
    endNav: 1000 + rate * 10, returnPct: rate, fetchedAt: at.toISOString(), provisional: true }] },
});

test('Feishu data seals immediately and switches Discord before noon', () => {
  const store = new FrozenPresenceStore();
  store.capture(raw(new Date('2026-10-10T03:00:00Z'), 2, '2026-10-09'), time('02:00'));
  store.capture(raw(time('02:30')), time('02:30'));
  assert.equal(store.latest(raw(time('02:30')), '2026-10-12', time('02:30'))!.returnPct, 2);
  store.recordReport(facts(time('03:00')), time('03:00'));
  assert.equal(store.latest(raw(time('03:00')), '2026-10-12', time('03:00'))!.capturedAt, time('03:00').toISOString());
  store.capture(raw(time('03:59'), -2.7), time('03:59'));
  assert.equal(store.get(raw(time('03:59')), '2026-10-12', time('03:59'))!.returnPct, -3.58);
  assert.equal(store.latest(raw(time('03:59')), '2026-10-12', time('03:59'))!.returnPct, -3.58);
  const sealed = store.latest(raw(time('04:00')), '2026-10-12', time('04:00'))!;
  assert.equal(sealed.date, '2026-10-12');
  assert.equal(sealed.returnPct, -3.58);
  assert.equal(sealed.source, 'feishu-report');
  store.capture(raw(time('08:00'), -1), time('08:00'));
  assert.equal(store.latest(raw(time('08:00')), '2026-10-12', time('08:00'))!.returnPct, -3.58);
});

test('without a report, only the last observation before noon may seal; afternoon data cannot backfill', () => {
  const store = new FrozenPresenceStore();
  store.capture(raw(time('03:00'), -3.5), time('03:00'));
  store.capture(raw(time('03:59'), -3.6), time('03:59'));
  store.capture(raw(time('04:01'), -2.82), time('04:01'));
  assert.equal(store.recordReport(facts(time('08:00')), time('08:00')).account.returnPct, -3.6);
  const empty = new FrozenPresenceStore();
  empty.capture(raw(time('04:01')), time('04:01'));
  assert.equal(empty.latest(raw(time('04:01')), '2026-10-12', time('04:01')), null);
  assert.throws(() => empty.recordReport(facts(time('08:00')), time('08:00')), /不能用午后数据/);
  const delayed = { ...facts(time('03:59')), accountAsOf: time('04:01').toISOString() };
  assert.throws(() => empty.recordReport(delayed, time('04:01')), /不能用午后数据/);
  assert.equal(dailyCutoff('2026-12-07'), Date.parse('2026-12-08T04:00:00Z'));
});

test('report regeneration and restarted Discord use the same sealed financial facts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-shared-'));
  try {
    const store = new FrozenPresenceStore(directory);
    let clock = time('03:00'), loaded = facts(clock);
    const reports = new DailyReports(directory, { configured: false } as AccountModel,
      async () => loaded, value => store.recordReport(value, clock));
    const first = await reports.generate();
    assert.match(first, /-3.5800%/);
    clock = time('08:00'); loaded = facts(clock, -2.82);
    assert.equal(await reports.generate(), first);
    const restored = new FrozenPresenceStore(directory);
    const fixed = restored.latest(raw(clock), '2026-10-12', clock)!;
    assert.equal(fixed.returnPct, -3.58);
    assert.equal(fixed.sourceFetchedAt, time('03:00').toISOString());
    assert.equal(restored.applyFacts(loaded, clock).account.returnPct, -3.58);
    const foreign = { ...raw(clock), accounts: { other: { base_currency: 'USD' } } };
    assert.equal(restored.latest(foreign, '2026-10-12', clock), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
