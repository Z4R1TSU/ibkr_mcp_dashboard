import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PerformanceStore } from '../server/performance-store.js';
import { PerformanceSource } from '../server/performance-source.js';
import { presencePerformance } from '../server/discord/performance.js';
import { dailyPerformance } from '../server/daily-performance.js';
import { capitalReturn, navChange } from '../server/returns.js';
import { PresenceData } from '../server/discord/data.js';
import type { DashboardState } from '../shared/types.js';

const raw = () => ({ portfolio_measure: 'TWR', accounts: { account: { base_currency: 'USD', periods: {
  YTD: { frequency: 'D', start_date: '20260924', start_nav: 1000,
    dates: ['20260925', '20260928'], nav: [1100, 990], cps: [0.1, -0.01] },
} } } });
const now = new Date('2026-09-30T06:00:00Z');

test('post-close valuations stay provisional until a later NY date supplies revised history', async () => {
  const early = new Date('2026-10-13T03:00:00Z'), later = new Date('2026-10-13T11:00:00Z');
  const input = { portfolio_measure: 'TWR', accounts: { account: { base_currency: 'USD', periods: {
    YTD: { frequency: 'D', start_date: '20261008', start_nav: 100,
      dates: ['20261009', '20261012'], nav: [100, 96.42], cps: [0, -0.0358] },
  } } } };
  const store = new PerformanceStore();
  let data = store.ingest(input, early);
  const state = { snapshot: { fetchedAt: early.toISOString(), account: { nav: 96.42, currency: 'USD' } },
    status: { connected: true, stale: false } } as DashboardState;
  const source = new PresenceData(() => state, async () => data, async () => '2026-10-12');
  await source.refresh(early);
  assert.equal(source.summary('2026-10-01', early, 100).performance!.provisional, true);
  assert.match(source.summary('2026-10-01', early, 100).activity!.state, /昨日\(10\/12\) —$/);
  const revised = structuredClone(input);
  revised.accounts.account.periods.YTD.nav[1] = 97.18;
  revised.accounts.account.periods.YTD.cps[1] = -0.0282;
  revised.accounts.account.periods.YTD.dates.push('20261013');
  revised.accounts.account.periods.YTD.nav.push(96);
  revised.accounts.account.periods.YTD.cps.push(-0.04);
  data = store.ingest(revised, later);
  state.snapshot!.fetchedAt = later.toISOString();
  await source.refresh(later);
  const value = source.summary('2026-10-01', later, 100);
  assert.equal(value.performance!.date, '2026-10-12');
  assert.equal(value.performance!.provisional, false);
  assert.match(value.activity!.state, /昨日\(10\/12\) -3.58%$/);
  assert.equal(value.performance!.updatedAt, later.toISOString());
});
function report(dir: string) {
  fs.mkdirSync(path.join(dir, 'daily-reports'));
  fs.writeFileSync(path.join(dir, 'daily-reports', '2026-09-29.json'), JSON.stringify({ facts: {
    generatedAt: now.toISOString(), account: { date: '2026-09-29', previousDate: '2026-09-28',
      currency: 'USD', startNav: 990, endNav: 1089, returnPct: 10, measure: 'TWR' },
  } }));
}

test('regressed IB data retains a newer reported day through restart and offline fetch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-history-'));
  try {
    report(dir);
    fs.writeFileSync(path.join(dir, 'pa-performance-latest.json'), JSON.stringify({ fetchedAt: now.toISOString(), data: raw() }));
    const store = new PerformanceStore(dir);
    assert.equal(dailyPerformance(store.view(true), '2026-09-29').endNav, 1089);
    const merged = store.ingest(raw(), now) as any;
    const sourceView = new PresenceData(() => ({ snapshot: { account: { currency: 'USD', nav: 1100 }, fetchedAt: now.toISOString() }, status: { connected: true, stale: false } }) as DashboardState,
      async () => merged, async () => '2026-09-30', async () => '2026-09-29');
    await sourceView.refresh();
    assert.equal(sourceView.summary('2026-09-25').performance!.date, '2026-09-29');
    assert.match(sourceView.summary('2026-09-25').warnings.join(' '), /2026-09-30 业绩尚未到达/);
    assert.equal(merged.local_archive.providerLatest, '2026-09-28');
    assert.equal(merged.local_archive.latestDate, '2026-09-29');
    const result = presencePerformance(merged, '2026-09-29', '2026-09-25');
    assert.ok(Math.abs(result.value.totalReturnPct! - 8.9) < 1e-8);
    assert.ok(Math.abs(result.value.dailyReturnPct! - 10) < 1e-8);
    const source = new PerformanceSource({ call: async () => { throw new Error('offline'); } }, dir);
    const restored = await source.get() as any;
    assert.equal(restored.local_archive.offline, true);
    assert.equal(dailyPerformance(restored, '2026-09-29').endNav, 1089);
    assert.equal(fs.statSync(path.join(dir, 'performance-history.json')).mode & 0o777, 0o600);
    assert.equal(dailyPerformance(store.ingest(raw(), now), '2026-09-29').endNav, 1089);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('a missing interval is not fabricated into cumulative TWR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-gap-'));
  try {
    report(dir);
    const input = raw();
    input.accounts.account.periods.YTD.dates.pop();
    input.accounts.account.periods.YTD.nav.pop();
    input.accounts.account.periods.YTD.cps.pop();
    const result = new PerformanceStore(dir).ingest(input, now);
    assert.equal(presencePerformance(result, '2026-09-29', '2026-09-25').value.totalReturnPct, null);
    assert.equal(dailyPerformance(result, '2026-09-29').endNav, 1089);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('capital return is independent of PA data and current NAV change uses the saved close', () => {
  const total = capitalReturn(42984.589565811155, 'USD', 30714.15407754)!;
  assert.ok(Math.abs(total.pnlUsd - 12270.435488271155) < 1e-8);
  assert.ok(Math.abs(total.returnPct - 39.95) < 0.01);
  assert.equal(capitalReturn(1000, 'HKD', 100), null);
  assert.equal(capitalReturn(1000, 'USD', 0), null);
  assert.equal(navChange(1100, 'USD', '2026-09-30', { date: '2026-09-29', endNav: 1000 })!.changePct, 10);
});

test('valid broker revisions are saved while an account change cannot inherit old reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-revision-'));
  try {
    report(dir);
    const store = new PerformanceStore(dir);
    store.ingest(raw(), now);
    const revision = raw();
    revision.accounts.account.periods.YTD.dates.push('20260929');
    revision.accounts.account.periods.YTD.nav.push(1080);
    revision.accounts.account.periods.YTD.cps.push(0.08);
    assert.equal(dailyPerformance(store.ingest(revision, now), '2026-09-29').endNav, 1080);
    assert.equal(dailyPerformance(store.ingest(raw(), now), '2026-09-29').endNav, 1080);
    const switched = { portfolio_measure: 'TWR', accounts: { another: raw().accounts.account } };
    assert.throws(() => dailyPerformance(store.ingest(switched, now), '2026-09-29'));
    assert.throws(() => dailyPerformance(store.ingest(switched, now), '2026-09-29'));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('legacy weekend valuations cannot replace Friday returns or break the trading chain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-weekend-'));
  const now = new Date('2026-10-12T04:00:00Z');
  const row = (date: string, previousDate: string, startNav: number, endNav: number, returnPct: number) =>
    ({ date, previousDate, startNav, endNav, returnPct, fetchedAt: '2026-10-10T03:00:00Z', source: 'ib-pa', provisional: false });
  const days = [
    row('2026-10-08', '2026-10-07', 200, 200, 0),
    row('2026-10-09', '2026-10-08', 200, 220, 10),
    row('2026-10-10', '2026-10-09', 220, 221, 0.45),
    row('2026-10-11', '2026-10-09', 220, 222, 0.9),
    row('2026-10-12', '2026-10-09', 220, 223, 1.36),
  ];
  const file = path.join(dir, 'performance-history.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, accountId: 'account', currency: 'USD',
    days: Object.fromEntries(days.map(day => [day.date, day])) }));
  try {
    const store = new PerformanceStore(dir);
    const data = store.view(true, now) as any;
    assert.equal(data.local_archive.latestDate, '2026-10-09');
    assert.equal(data.local_archive.records, 2);
    assert.deepEqual(data.accounts.account.periods.LOCAL.dates, ['2026-10-08', '2026-10-09']);
    const state = { snapshot: { account: { currency: 'USD', nav: 222 }, fetchedAt: now.toISOString() },
      status: { connected: true, stale: false } } as DashboardState;
    for (const offline of [false, true]) {
      const source = new PresenceData(() => state, async () => data, async () => {
        if (offline) throw new Error('calendar unavailable');
        return '2026-10-09';
      });
      await source.refresh(now);
      const summary = source.summary('2026-10-08', now, 100);
      assert.equal(summary.performance!.date, '2026-10-09');
      assert.ok(Math.abs(summary.performance!.dailyReturnPct! - 10) < 1e-8);
      assert.ok(summary.activity!.state.endsWith('昨日(10/09) +10.00%'));
      assert.equal(summary.total!.returnPct, 122);
    }
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).days['2026-10-11'].returnPct, 0.9);
    const monday = { portfolio_measure: 'TWR', accounts: { account: { base_currency: 'USD', periods: {
      '7D': { frequency: 'D', start_date: '20261008', start_nav: 200,
        dates: ['20261009', '20261012'], nav: [220, 224.4], cps: [0.1, 0.122] },
    } } } };
    const afterClose = store.ingest(monday, new Date('2026-10-12T20:01:00Z')) as any;
    assert.equal(afterClose.local_archive.latestDate, '2026-10-12');
    assert.ok(Math.abs(dailyPerformance(afterClose, '2026-10-12').returnPct! - 2) < 1e-8);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
