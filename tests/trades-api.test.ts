import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { Vault } from '../server/vault.js';
import { config } from '../server/config.js';
import type { Collector } from '../server/collector.js';
import type { IbkrClient } from '../server/ibkr.js';

test('trade endpoints enforce access, return immediately, and only expose normalized fields', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-trades-api-'));
  const vault = new Vault(directory);
  vault.setPassword('a-long-testing-password');
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = { oauth: { vault }, call: async () => {
    calls++; await gate;
    return { trades: [{ trade_id: 'one', trade_time: new Date().toISOString(), symbol: 'TEST', account_id: 'PRIVATE-FIXTURE' }] };
  } } as unknown as IbkrClient;
  const collector = new EventEmitter() as Collector;
  const server = createApp(client, collector, { ...config, accessMode: 'password' }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = new URL(config.publicUrl).origin;
  try {
    assert.equal((await fetch(base + '/api/trades')).status, 401);
    assert.equal(calls, 0);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-testing-password' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const session = await login.json() as { csrf: string };
    const headers = { Cookie: cookie, Origin: origin };
    assert.equal((await fetch(base + '/api/trades/refresh', { method: 'POST', headers })).status, 403);
    assert.equal(calls, 0);
    assert.equal((await fetch(base + '/api/trades?range=constructor', { headers })).status, 400);
    const initial = await fetch(base + '/api/trades?range=today', { headers, signal: AbortSignal.timeout(2000) });
    assert.equal(initial.status, 200);
    assert.equal((await initial.json() as any).refreshing, true);
    const defaultRange = await (await fetch(base + '/api/trades', { headers })).json() as any;
    assert.equal(defaultRange.range, 'previous');
    assert.equal(defaultRange.startDate, defaultRange.endDate);
    assert.equal(calls, 1);
    const refresh = await fetch(base + '/api/trades/refresh', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': session.csrf } });
    assert.equal(refresh.status, 202);
    assert.equal(calls, 1);
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    const response = await fetch(base + '/api/trades?range=today', { headers });
    const body = await response.text();
    assert.doesNotMatch(body, /PRIVATE-FIXTURE|account_id|access_token/);
    const data = JSON.parse(body);
    assert.equal(data.timeZone, 'America/New_York');
    assert.equal(data.range, 'today');
    assert.equal(data.trades.length, 1);
    assert.equal(data.trades[0].size, null);
    assert.equal(data.stale, false);
    assert.equal(calls, 1);
  } finally {
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true });
  }
});
