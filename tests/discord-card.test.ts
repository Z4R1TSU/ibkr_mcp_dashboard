import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrozenPresenceStore } from '../server/discord/frozen.js';
import { presenceToday } from '../server/discord/today.js';
import { PresenceData } from '../server/discord/data.js';
import type { DashboardState } from '../shared/types.js';

function data(asOf = '2026-10-13T08:00:00Z', account = 'one') {
  return { portfolio_measure: 'TWR', accounts: { [account]: { base_currency: 'USD', periods: {
    LOCAL: { frequency: 'D', start_date: '20261009', start_nav: 1000, dates: ['20261012'], nav: [970], cps: [-0.03] },
  } } }, local_archive: {
    latestDate: '2026-10-12', providerLatest: '2026-10-12', offline: false, records: 1,
    closingDays: [{ date: '2026-10-12', previousDate: '2026-10-09', startNav: 1000, endNav: 970,
      returnPct: -3, fetchedAt: '2026-10-13T03:00:00Z', provisional: true }],
    currentDay: { date: '2026-10-13', previousDate: '2026-10-12', currency: 'USD', startNav: 970,
      endNav: 990, navChange: 20, returnPct: 20 / 970 * 100, flowMismatch: false, asOf },
  } };
}

test('the card freezes yesterday and uses the current IB baseline for today', async () => {
  const raw = data(), now = new Date('2026-10-13T08:00:00Z');
  const state = { snapshot: { fetchedAt: now.toISOString(), account: { nav: 990, currency: 'USD' } },
    status: { connected: true, stale: false } } as DashboardState;
  let completed = '2026-10-12';
  const source = new PresenceData(() => state, async () => raw, async () => completed);
  await source.refresh(now);
  let summary = source.summary('2026-03-31', now, 900);
  assert.equal(summary.activity!.details, '净值 $990.00 · 总 +10.00%');
  assert.equal(summary.activity!.state, '今日 +$20.00 · 昨日(10/12) -3.00%');
  state.status.stale = true;
  assert.match(source.summary('2026-03-31', now, 900).activity!.details, /^旧值/);
  assert.equal(source.summary('2026-03-31', now, 900).activity!.largeImageKey, 'portfolio_down');
  state.status.stale = false;
  raw.local_archive.closingDays[0].returnPct = -2;
  raw.local_archive.closingDays[0].endNav = 980;
  raw.local_archive.currentDay.startNav = 980;
  raw.local_archive.currentDay.returnPct = 10 / 980 * 100;
  await source.refresh(now);
  summary = source.summary('2026-03-31', now, 900);
  assert.equal(summary.activity!.state, '今日 +$10.00 · 昨日(10/12) -3.00%');
  assert.ok(summary.warnings.some(warning => warning.includes('后续修订')));
  completed = '2026-10-13';
  raw.accounts.one.periods.LOCAL.dates.push('20261013');
  raw.accounts.one.periods.LOCAL.nav.push(990);
  raw.accounts.one.periods.LOCAL.cps.push(-0.01);
  const afterClose = new Date('2026-10-13T21:00:00Z');
  await source.refresh(afterClose);
  assert.equal(source.summary('2026-03-31', afterClose, 900).yesterday!.date, '2026-10-12');
  const midnight = source.summary('2026-03-31', new Date('2026-10-14T04:10:00Z'), 900);
  assert.equal(midnight.yesterday!.date, '2026-10-12');
  assert.match(midnight.activity!.state, /^今日 待盘前 · 上日\(10\/12\) -3.00%$/);
  raw.local_archive.closingDays.push({ date: '2026-10-13', previousDate: '2026-10-12', startNav: 980,
    endNav: 999.6, returnPct: 2, fetchedAt: '2026-10-14T03:00:00Z', provisional: true });
  await source.refresh(new Date('2026-10-14T03:00:00Z'));
  assert.match(source.summary('2026-03-31', new Date('2026-10-14T03:59:00Z'), 900).activity!.state, /上日\(10\/12\) -3.00%$/);
  assert.match(source.summary('2026-03-31', new Date('2026-10-14T04:00:00Z'), 900).activity!.state, /昨日\(10\/13\) \+2.00%$/);
});

test('yesterday seals at Beijing noon and survives revisions, mutation and restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-frozen-'));
  try {
    const store = new FrozenPresenceStore(directory);
    const now = new Date('2026-10-13T04:00:00Z');
    const raw = data();
    const early = new Date('2026-10-13T03:00:00Z');
    store.capture(raw, early);
    assert.equal(store.get(raw, '2026-10-12', early), null);
    store.capture(raw, now);
    const fixed = store.get(raw, '2026-10-12')!;
    assert.equal(fixed.returnPct, -3);
    fixed.returnPct = 99;
    const file = path.join(directory, 'discord-daily-snapshots.json');
    const saved = fs.readFileSync(file, 'utf8');
    raw.local_archive.closingDays[0].returnPct = -2;
    raw.local_archive.closingDays[0].endNav = 980;
    store.capture(raw, now);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.equal(new FrozenPresenceStore(directory).get(raw, '2026-10-12')!.returnPct, -3);
    const state = { snapshot: { fetchedAt: now.toISOString(), account: { nav: 990, currency: 'USD' } },
      status: { connected: false, stale: true } } as DashboardState;
    const offline = new PresenceData(() => state, async () => { throw new Error('offline'); },
      async () => '2026-10-12', undefined, new FrozenPresenceStore(directory), raw);
    assert.equal(offline.summary('2026-03-31', now, 900).yesterday!.returnPct, -3);
    assert.equal(store.get(data(undefined, 'another'), '2026-10-12'), null);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('noon cutoff rejects future and afternoon records and accepts overnight valuation', () => {
  const store = new FrozenPresenceStore();
  const raw = data('2026-01-17T08:59:00Z');
  const row = raw.local_archive.closingDays[0];
  row.date = '2026-01-16'; row.previousDate = '2026-01-15';
  row.fetchedAt = '2026-01-17T08:59:00Z';
  const now = new Date('2026-01-17T09:00:00Z');
  store.capture(raw, now);
  assert.equal(store.get(raw, row.date), null);
  row.fetchedAt = '2026-01-17T09:01:00Z';
  store.capture(raw, now);
  assert.equal(store.get(raw, row.date), null);
  row.fetchedAt = now.toISOString(); row.provisional = true;
  store.capture(raw, now);
  assert.equal(store.get(raw, row.date), null);
  row.provisional = false;
  row.fetchedAt = '2026-01-17T03:00:00Z';
  store.capture(raw, now);
  assert.equal(store.get(raw, row.date)!.returnPct, -3);
});

test('today placeholders follow premarket, holidays, stale data and flow mismatches', () => {
  const raw = data(), now = new Date('2026-10-13T08:00:00Z');
  assert.equal(presenceToday(raw, 'USD', new Date('2026-10-13T07:59:00Z')).status, 'before_premarket');
  const morning = presenceToday(raw, 'USD', new Date('2026-10-13T03:00:00Z'));
  assert.equal(morning.date, '2026-10-13');
  assert.equal(morning.status, 'before_premarket');
  assert.equal(presenceToday(raw, 'USD', new Date('2026-10-11T15:00:00Z')).status, 'closed');
  assert.equal(presenceToday(raw, 'USD', new Date('2026-12-25T15:00:00Z')).status, 'closed');
  assert.equal(presenceToday(raw, 'USD', now).amount, 20);
  assert.equal(presenceToday(raw, 'USD', new Date(now.getTime() + 600000)).status, 'stale');
  raw.local_archive.currentDay.endNav += 1000;
  assert.equal(presenceToday(raw, 'USD', now).status, 'flow_mismatch');
  assert.equal(presenceToday(raw, 'HKD', now).status, 'pending');
});
