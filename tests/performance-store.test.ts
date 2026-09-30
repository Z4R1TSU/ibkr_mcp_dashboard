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
