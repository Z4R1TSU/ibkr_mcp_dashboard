import test from 'node:test';
import assert from 'node:assert/strict';
import { IbkrClient, type IbkrOAuth } from '../server/ibkr.js';
import { waitFor } from '../server/read-queue.js';

test('account reads precede queued background work and cannot be interleaved', async t => {
  t.mock.method(console, 'info', () => {});
  const client = new IbkrClient({} as IbkrOAuth), calls: string[] = [];
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = new Promise<void>(resolve => { started = resolve; });
  const connection = { callTool: async ({ name }: { name: string }) => {
    calls.push(name);
    if (name === 'get_price_history') { started(); await gate; }
    return { structuredContent: { name } };
  }, close: async () => {} };
  t.mock.method(client as any, 'connect', async () => connection);
  const first = client.call('get_price_history');
  await active;
  const background = client.call('get_account_trades');
  const phases: string[] = [];
  const account = client.readAccount(phase => phases.push(phase));
  const controller = new AbortController();
  const cancelled = assert.rejects(client.call('get_price_snapshot', {}, { signal: controller.signal }), { name: 'AbortError' });
  controller.abort(); await cancelled;
  release();
  const [, , result] = await Promise.all([first, background, account]);
  assert.deepEqual(calls, ['get_price_history', 'get_account_positions', 'get_account_summary', 'get_account_balances', 'get_account_trades']);
  assert.deepEqual(phases.filter(p => p !== 'connecting'), ['positions', 'summary', 'balances']);
  assert.ok(Object.values(result.sources).every(time => Number.isFinite(Date.parse(time))));
  await assert.rejects(client.call('submit_order'));
});

test('cancelling an active account read stops later steps and releases the queue', async t => {
  t.mock.method(console, 'info', () => {});
  const client = new IbkrClient({} as IbkrOAuth), calls: string[] = [];
  let started!: () => void, closed = 0;
  const active = new Promise<void>(resolve => { started = resolve; });
  const connection = { callTool: async ({ name }: { name: string }, _schema: unknown, options: { signal: AbortSignal }) => {
    calls.push(name);
    if (name === 'get_account_positions') {
      started();
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    return { structuredContent: { name } };
  }, close: async () => { closed++; } };
  t.mock.method(client as any, 'connect', async () => { (client as any).client = connection; return connection; });
  const controller = new AbortController();
  const failed = assert.rejects(client.readAccount(undefined, controller.signal), { name: 'AbortError' });
  await active; controller.abort(); await failed;
  await client.call('get_account_orders');
  assert.equal(closed, 1);
  assert.deepEqual(calls, ['get_account_positions', 'get_account_orders']);
});

test('abandoning a reader does not cancel the shared token rotation', async () => {
  let finish!: (value: string) => void;
  const rotation = new Promise<string>(resolve => { finish = resolve; });
  const controller = new AbortController();
  const cancelled = assert.rejects(waitFor(rotation, controller.signal), { name: 'AbortError' });
  controller.abort(); await cancelled;
  const remaining = waitFor(rotation, new AbortController().signal);
  finish('rotated');
  assert.equal(await remaining, 'rotated');
});
