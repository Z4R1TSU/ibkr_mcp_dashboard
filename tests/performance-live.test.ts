import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PerformanceStore } from '../server/performance-store.js';
import { PerformanceSource } from '../server/performance-source.js';
import { PresenceData } from '../server/discord/data.js';
import { presenceToday } from '../server/discord/today.js';
import type { DashboardState } from '../shared/types.js';

const now = new Date('2026-10-15T14:00:00Z');
const earlier = new Date(now.getTime() - 60000);
function raw(withToday = true, end = 1020, id = 'one') {
  return { portfolio_measure: 'TWR', accounts: { [id]: { base_currency: 'USD', periods: {
    '7D': { frequency: 'D', start_date: '20261013', start_nav: 1000,
      dates: withToday ? ['20261014', '20261015'] : ['20261014'],
      nav: withToday ? [1000, end] : [1000], cps: withToday ? [0, end / 1000 - 1] : [0] },
  } } } };
}

test('today reads the latest shared source while calendar and previous-day lookups are still pending', async () => {
  const store = new PerformanceStore();
  let latest = store.ingest(raw(), earlier);
  const calendar = Promise.withResolvers<string>(), previous = Promise.withResolvers<string>();
  const state = { snapshot: { fetchedAt: now.toISOString(), account: { nav: 1030, currency: 'USD' } },
    status: { connected: true, stale: false } } as DashboardState;
  const presence = new PresenceData(() => state, async () => latest, () => calendar.promise,
    () => previous.promise, undefined, latest, () => latest);
  const refresh = presence.refresh(now);
  try {
    latest = store.ingest(raw(true, 1030), now);
    assert.equal(presence.summary('2026-01-01', now, 1000).todayPnl!.amount, 30);
    calendar.resolve('2026-10-14');
    await Promise.resolve();
    const newer = new Date(now.getTime() + 60000);
    latest = store.ingest(raw(true, 1040), newer);
    assert.equal(presence.summary('2026-01-01', newer, 1000).todayPnl!.amount, 40);
  } finally { calendar.resolve('2026-10-14'); previous.resolve('2026-10-14'); await refresh; }
});

test('same-day P&L survives partial responses and restart without renewing its source timestamp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-live-'));
  try {
    const store = new PerformanceStore(dir);
    store.ingest(raw(), now);
    const later = new Date(now.getTime() + 300000);
    const partial = store.ingest(raw(false), later) as any;
    assert.equal(partial.local_archive.currentDay.asOf, now.toISOString());
    assert.equal(presenceToday(partial, 'USD', later).amount, 20);
    const restarted = new PerformanceStore(dir).view(true, later) as any;
    assert.deepEqual(restarted.local_archive.currentDay, partial.local_archive.currentDay);
    assert.equal(presenceToday(restarted, 'USD', new Date(now.getTime() + 600000)).status, 'stale');
    assert.equal(presenceToday(restarted, 'USD', new Date(now.getTime() + 600000)).amount, null);
    const deposit = raw(true, 2020);
    deposit.accounts.one.periods['7D'].cps[1] = 0.02;
    const mismatch = store.ingest(deposit, later);
    assert.equal(presenceToday(mismatch, 'USD', later).status, 'flow_mismatch');
    assert.equal(presenceToday(mismatch, 'USD', later).amount, null);
    const switched = store.ingest(raw(false, 1020, 'other'), later) as any;
    assert.equal(switched.local_archive.currentDay, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy raw captures restore today using their original timestamp and account scope', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-legacy-'));
  try {
    new PerformanceStore(dir).ingest(raw(false), earlier);
    const capture = path.join(dir, 'pa-performance-latest.json');
    fs.writeFileSync(capture, JSON.stringify({ data: raw(), fetchedAt: earlier.toISOString() }));
    const restored = new PerformanceStore(dir).view(true, now) as any;
    assert.equal(restored.local_archive.currentDay.asOf, earlier.toISOString());
    assert.equal(presenceToday(restored, 'USD', now).amount, 20);
    fs.writeFileSync(capture, JSON.stringify({ data: raw(true, 1020, 'other'), fetchedAt: earlier.toISOString() }));
    assert.equal((new PerformanceStore(dir).view(true, now) as any).local_archive.currentDay, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed requests retry in 30/60/120 seconds despite the fallback cache, then resume five-minute polling', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-retry-'));
  new PerformanceStore(dir).ingest(raw(), earlier);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  let calls = 0;
  const source = new PerformanceSource({ call: async () => {
    calls++;
    if (calls <= 3) throw new Error('network unavailable');
    return raw();
  } }, dir);
  try {
    source.start(); await source.get();
    assert.equal(calls, 1);
    for (const [delay, expected] of [[30000, 2], [60000, 3], [120000, 4]]) {
      t.mock.timers.tick(delay - 1);
      assert.equal(calls, expected - 1);
      t.mock.timers.tick(1);
      await source.get();
      assert.equal(calls, expected);
    }
    assert.equal((source.peek() as any).local_archive.offline, false);
    t.mock.timers.tick(299999); assert.equal(calls, 4);
    t.mock.timers.tick(1); await source.get(); assert.equal(calls, 5);
    await source.stop(); source.start(); await source.get();
    t.mock.timers.tick(300000); await source.get(); assert.equal(calls, 6);
  } finally { await source.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a successful response without today also retries promptly without discarding the last amount', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-partial-'));
  new PerformanceStore(dir).ingest(raw(), earlier);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  let calls = 0;
  const source = new PerformanceSource({ call: async () => raw(++calls > 1, 1030) }, dir);
  try {
    source.start(); await source.get();
    const old = source.peek() as any;
    assert.equal(old.local_archive.currentDay.asOf, earlier.toISOString());
    assert.equal(presenceToday(old, 'USD', now).amount, 20);
    t.mock.timers.tick(30000); await source.get();
    assert.equal(calls, 2);
    assert.equal(presenceToday(source.peek(), 'USD', new Date()).amount, 30);
  } finally { await source.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a closed market reads PA once per shared slot instead of every five minutes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-closed-'));
  // Saturday 2026-10-17 13:00 UTC; the next six-hour slot is 18:00 UTC.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-10-17T13:00:00Z') });
  let calls = 0;
  const source = new PerformanceSource({ call: async () => { calls++; return raw(); } }, dir);
  try {
    source.start(); await source.get();
    assert.equal(calls, 1);
    t.mock.timers.tick(5 * 3600000 - 1); await source.get();
    assert.equal(calls, 1);
    t.mock.timers.tick(1); await source.get();
    assert.equal(calls, 2);
  } finally { await source.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a closed market reads PA once per shared slot instead of every five minutes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-closed-'));
  // Saturday 2026-10-17 13:00 UTC; the next six-hour slot is 18:00 UTC.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-10-17T13:00:00Z') });
  let calls = 0;
  const source = new PerformanceSource({ call: async () => { calls++; return raw(); } }, dir);
  try {
    source.start(); await source.get();
    assert.equal(calls, 1);
    t.mock.timers.tick(5 * 3600000 - 1); await source.get();
    assert.equal(calls, 1);
    t.mock.timers.tick(1); await source.get();
    assert.equal(calls, 2);
  } finally { await source.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
