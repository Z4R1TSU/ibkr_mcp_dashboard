import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { buildPnlCalendar } from '../server/pnl-calendar.js';
import type { Collector } from '../server/collector.js';
import type { IbkrClient } from '../server/ibkr.js';

test('funding API enforces access, shares yearly reads, and augments the calendar after refresh', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-flows-api-'));
  const year = new Date().getUTCFullYear(), date = year + '-01-01';
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = { oauth: { vault: { directory, checkPassword: () => true } }, call: async (name: string, args: any) => {
    calls++; assert.equal(name, 'get_account_trades'); assert.equal(args.period, 'YEAR_TO_DATE'); await gate;
    return { trades: [{ trade_id: 'buy', sec_type: 'CASH', symbol: 'USD.CNH', currency: 'CNH', side: 'BUY',
      size: 100, price: 7, net_amount: -700, trade_time: date + 'T12:00:00Z', account_id: 'PRIVATE-FIXTURE' }] };
  } } as unknown as IbkrClient;
  const performance = { calendar: (month: string, now = new Date()) => buildPnlCalendar(month, 'USD', [], undefined, now) };
  const server = createApp(client, new EventEmitter() as Collector, { ...config, accessMode: 'password' },
    undefined, undefined, undefined, performance).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const origin = new URL(config.publicUrl).origin;
  try {
    assert.equal((await fetch(base + '/api/cash-flows')).status, 401);
    assert.equal(calls, 0);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: origin } });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const session = await login.json() as { csrf: string };
    const headers = { Cookie: cookie, Origin: origin };
    assert.equal((await fetch(base + '/api/cash-flows/refresh', { method: 'POST', headers })).status, 403);
    assert.equal(calls, 0);
    const initial = await (await fetch(base + '/api/cash-flows', { headers, signal: AbortSignal.timeout(2000) })).json() as any;
    assert.equal(initial.refreshing, true);
    assert.equal(initial.fetchedAt, null);
    await fetch(base + '/api/trades?range=year', { headers });
    await fetch(base + '/api/pnl-calendar?month=' + year + '-01', { headers });
    assert.equal(calls, 1);
    assert.equal((await fetch(base + '/api/cash-flows/refresh', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': session.csrf } })).status, 202);
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    const response = await fetch(base + '/api/cash-flows', { headers });
    const body = await response.text();
    assert.doesNotMatch(body, /PRIVATE-FIXTURE|account_id|access_token/);
    const data = JSON.parse(body);
    assert.equal(data.records.length, 1);
    assert.equal(data.records[0].date, date);
    assert.equal(data.totals.net, 100);
    assert.deepEqual(data.exchangeRates, [{ currency: 'CNH', depositRate: 7, withdrawalRate: null }]);
    const calendar = await (await fetch(base + '/api/pnl-calendar?month=' + year + '-01', { headers })).json() as any;
    assert.equal(calendar.days[0].cashFlows[0].amount, 100);
    assert.equal(calendar.days[0].status, 'closed');
    assert.equal(calendar.summary.pnl, null);
    assert.equal(calendar.cashFlows.totals.deposits, 100);
    assert.equal(calls, 1);
  } finally {
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true });
  }
});
