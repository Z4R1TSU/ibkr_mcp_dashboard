import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collector } from '../server/collector.js';
import type { IbkrClient } from '../server/ibkr.js';

test('collector deduplicates refresh, retains successful snapshot on errors, and restores stale state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-collector-test-'));
  let calls = 0;
  let fail = false;
  const client = {
    oauth: { vault: { get: () => ({ oauth: { tokens: { scope: 'mcp.read' } } }) } },
    disconnect: async () => undefined,
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
    fs.writeFileSync(path.join(directory, 'dashboard.json'), JSON.stringify(stored));
    const restored = new Collector(client, directory);
    assert.equal(restored.view().snapshot?.account.nav, 1000);
    assert.equal(restored.view().status.stale, true);
    await restored.pause();
  } finally {
    await collector.pause();
    fs.rmSync(directory, { recursive: true });
  }
});
