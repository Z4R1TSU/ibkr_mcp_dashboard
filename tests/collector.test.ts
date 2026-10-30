import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collector, collectorDelay } from '../server/collector.js';
import type { IbkrClient, AccountRead, AccountReadPhase } from '../server/ibkr.js';

test('collector deduplicates refresh, retains successful snapshot on errors, and restores stale state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-collector-test-'));
  let calls = 0;
  let fail = false;
  const client = {
    oauth: { vault: { get: () => ({ oauth: { tokens: { scope: 'mcp.read' } } }) } },
    disconnect: async () => undefined,
    readAccount: async (progress: (phase: AccountReadPhase) => void, signal: AbortSignal) => {
      const result = { sources: {} } as AccountRead;
      for (const phase of ['positions', 'summary', 'balances'] as const) {
        signal.throwIfAborted(); progress(phase);
        result[phase] = await client.call('get_account_' + phase);
        result.sources[phase] = new Date().toISOString();
      }
      return result;
    },
    call: async (name: string) => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      if (fail) throw new Error('Simulated upstream failure');
      if (name === 'get_account_positions') return { positions: [] };
      if (name === 'get_account_summary') return { currency: 'USD', net_liquidation: 1000, total_cash_value: 1000 };
      if (name === 'get_account_balances') return { balances: [{ currency: 'BASE', unrealized_pnl: 0 }] };
      throw new Error('Unexpected tool');
    },
  } as unknown as IbkrClient;
  const collector = new Collector(client, directory);
  try {
    const first = collector.refresh();
    const second = collector.refresh();
    assert.equal(first, second);
    await first;
    assert.equal(calls, 3);
    assert.equal(collector.view().status.stale, false);
    assert.equal(collector.view().history.length, 1);
    assert.equal(collector.view().dailyHistory?.length, 1);
    assert.equal(collector.view().historyTimeZone, 'America/New_York');
    const success = collector.view().snapshot;
    fail = true;
    await collector.refresh();
    assert.equal(collector.view().snapshot, success);
    assert.equal(collector.view().history.length, 1);
    assert.ok(collector.view().status.error);
    assert.equal(collector.view().status.refreshing, false);
    await collector.pause();
    const stored = JSON.parse(fs.readFileSync(path.join(directory, 'dashboard.json'), 'utf8'));
    stored.snapshot.sources.positions = '2020-01-01T00:00:00Z';
    stored.dailyHistory = [{ time: new Date(Date.now() - 30 * 86400000).toISOString(), nav: 800 }];
    stored.history.unshift({ time: new Date(Date.now() - 10 * 86400000).toISOString(), nav: 900 });
    fs.writeFileSync(path.join(directory, 'dashboard.json'), JSON.stringify(stored));
    const restored = new Collector(client, directory);
    assert.equal(restored.view().snapshot?.account.nav, 1000);
    assert.equal(restored.view().status.stale, true);
    assert.deepEqual(restored.view().dailyHistory?.map(point => point.nav), [800, 900, 1000]);
    fail = false;
    await restored.refresh();
    assert.equal(restored.view().history.some(point => point.nav === 900), false);
    assert.deepEqual(restored.view().dailyHistory?.map(point => point.nav), [800, 900, 1000]);
    await restored.pause();
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'dashboard.json'), 'utf8'));
    assert.equal(saved.historyTimeZone, 'America/New_York');
    assert.equal(saved.status.refreshing, false);
    assert.equal(saved.status.phase, 'idle');
    assert.deepEqual(saved.dailyHistory.map((point: { nav: number }) => point.nav), [800, 900, 1000]);
  } finally {
    await collector.pause();
    fs.rmSync(directory, { recursive: true });
  }
});

test('legacy daily samples are regrouped by New York date on restore', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-nav-timezone-'));
  const earlier = { time: '2026-10-10T15:59:59Z', nav: 1000 };
  const later = { time: '2026-10-11T03:59:59Z', nav: 1010 };
  const next = { time: '2026-10-11T04:00:00Z', nav: 1020 };
  try {
    fs.writeFileSync(path.join(directory, 'dashboard.json'), JSON.stringify({
      snapshot: { version: 1, sources: {} }, historyTimeZone: 'Asia/Shanghai',
      dailyHistory: [earlier, later], history: [next],
    }));
    const client = { oauth: { vault: { get: () => ({}) } } } as unknown as IbkrClient;
    const state = new Collector(client, directory).view();
    assert.equal(state.historyTimeZone, 'America/New_York');
    assert.deepEqual(state.dailyHistory, [later, next]);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('failed collection retries are bounded to two minutes', () => {
  const open = Date.parse('2026-10-19T14:00:00Z');
  assert.equal(collectorDelay(60, 0, open), 60000);
  for (const at of [open, Date.parse('2026-10-17T13:00:00Z')]) {
    assert.equal(collectorDelay(60, 1, at), 30000);
    assert.equal(collectorDelay(60, 2, at), 60000);
    for (const failures of [3, 5, 20, 100]) assert.equal(collectorDelay(60, failures, at), 120000);
  }
});

test('closed markets poll in shared slots and keep the last snapshot current until the next one', async t => {
  // Saturday 2026-10-17 13:00 UTC; the next six-hour slot is 18:00 UTC.
  const saturday = Date.parse('2026-10-17T13:00:00Z');
  assert.equal(collectorDelay(60, 0, saturday), 5 * 3600000);
  // Sunday evening: the Monday open (08:00 UTC) comes before the next slot.
  assert.equal(new Date(Date.parse('2026-10-19T06:30:00Z') + collectorDelay(60, 0, Date.parse('2026-10-19T06:30:00Z'))).toISOString(), '2026-10-19T08:00:00.000Z');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-collector-closed-'));
  t.mock.timers.enable({ apis: ['Date'], now: saturday });
  const time = new Date(saturday).toISOString();
  const snapshot = { version: 1, fetchedAt: time, sources: { positions: time, summary: time, balances: time } };
  fs.writeFileSync(path.join(directory, 'dashboard.json'), JSON.stringify({ snapshot, history: [] }));
  const client = { oauth: { vault: { get: () => ({ oauth: { tokens: { scope: 'mcp.read' } } }) } } } as unknown as IbkrClient;
  try {
    const collector = new Collector(client, directory);
    t.mock.timers.tick(4 * 3600000);
    assert.equal(collector.view().status.stale, false);
    t.mock.timers.tick(3600000 + 180000 + 1);
    assert.equal(collector.view().status.stale, true);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('quote timeouts keep the successful account snapshot and finish the round', async t => {
  t.mock.method(console, 'info', () => {});
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-quote-budget-'));
  const quoteBudget = new AbortController(), originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => ms === 20000 ? quoteBudget.signal : originalTimeout(ms));
  let started!: () => void;
  const quoteStarted = new Promise<void>(resolve => { started = resolve; });
  const time = new Date().toISOString();
  const client = {
    oauth: { vault: { get: () => ({ oauth: { tokens: { scope: 'mcp.read' } } }) } },
    disconnect: async () => {},
    readAccount: async () => ({ positions: { positions: [{ contract_id: 1, contract_description: 'TEST', asset_class: 'STK', currency: 'USD', position: 1, market_value: 100 }] },
      summary: { currency: 'USD', net_liquidation: 1000, total_cash_value: 900 }, balances: { balances: [] }, sources: { positions: time, summary: time, balances: time } }),
    call: async (_name: string, _args: unknown, options: { signal: AbortSignal }) => {
      started();
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    },
  } as unknown as IbkrClient;
  const collector = new Collector(client, directory);
  try {
    const pending = collector.refresh();
    await quoteStarted;
    assert.equal(collector.view().snapshot?.account.nav, 1000);
    assert.equal(collector.view().status.refreshing, false);
    assert.equal(collector.view().status.phase, 'quotes');
    quoteBudget.abort(new DOMException('fixture-timeout', 'TimeoutError'));
    await pending;
    assert.equal(collector.view().status.phase, 'idle');
    assert.equal(collector.view().status.error, null);
    assert.ok(collector.view().status.quoteError);
    assert.equal(collector.view().snapshot?.fetchedAt, time);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'dashboard.json'), 'utf8'));
    assert.equal(saved.status.refreshing, false);
    assert.equal(saved.status.phase, 'idle');
  } finally { await collector.pause(); fs.rmSync(directory, { recursive: true }); }
});
