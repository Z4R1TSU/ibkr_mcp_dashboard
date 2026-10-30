import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginAlerts } from '../server/bot/login-alerts.js';
import { BotStore } from '../server/bot/store.js';
import type { BrokerAuthState, BrokerId } from '../shared/broker-auth.js';

const now = new Date('2026-10-27T03:00:00Z');
function fixture(t: import('node:test').TestContext, owner = 'ou_owner') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'login-alerts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'warn', () => {});
  const config = { enabled: true, profile: 'test', cliPath: 'unused', ownerOpenId: owner,
    dataDir: directory, timeZone: 'Asia/Shanghai', publicUrl: 'https://dashboard.test' };
  const store = new BotStore(directory, 'test', owner);
  const states: Record<BrokerId, BrokerAuthState> = { ibkr: 'ready', schwab: 'ready' };
  const sent: { to: string; text: string; key: string }[] = [];
  const transport = { send: async (to: string, text: string, key: string) => { sent.push({ to, text, key }); } };
  const read = (broker: BrokerId) => states[broker];
  const alerts = new LoginAlerts(config, store, read, transport);
  const restart = () => new LoginAlerts(config, new BotStore(directory, 'test', owner), read, transport);
  return { directory, config, store, states, sent, transport, read, alerts, restart };
}

test('both brokers notify by default, deduplicate across restarts, and rearm only on recovery', async t => {
  const f = fixture(t);
  assert.equal(f.store.state.alerts, false);
  f.states.ibkr = f.states.schwab = 'login_required';
  await f.alerts.check(now);
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(row => row.to === 'ou_owner'));
  assert.match(f.sent[0].text, /IBKR.*需要重新登录/);
  assert.match(f.sent[1].text, /https:\/\/dashboard.test\/tos-login\//);
  await f.alerts.check(now);
  const restarted = f.restart();
  await restarted.check(new Date(now.getTime() + 10 * 86400000));
  assert.equal(f.sent.length, 2);
  f.states.ibkr = 'unknown';
  await restarted.check(now);
  f.states.ibkr = 'login_required';
  await restarted.check(now);
  assert.equal(f.sent.length, 2);
  f.states.ibkr = 'ready';
  await restarted.check(now);
  assert.equal(f.sent.length, 2);
  f.states.ibkr = 'login_required';
  await restarted.check(now);
  assert.equal(f.sent.length, 3);
  assert.notEqual(f.sent[2].key, f.sent[0].key);
  assert.equal(fs.statSync(path.join(f.directory, 'feishu-bot.json')).mode & 0o777, 0o600);
});

test('a failed delivery is retried after restart with the same identity and message', async t => {
  const f = fixture(t);
  f.states.ibkr = f.states.schwab = 'login_required';
  let fail = true;
  const send = f.transport.send;
  f.transport.send = async (to, text, key) => {
    await send(to, text, key);
    if (fail && key.includes(':ibkr:')) throw new Error('private fixture failure');
  };
  await f.alerts.check(now);
  assert.equal(f.sent.length, 2);
  assert.equal(f.store.state.loginAlerts?.ibkr?.sentAt, null);
  assert.ok(f.store.state.loginAlerts?.schwab?.sentAt);
  assert.ok(f.alerts.status().brokers.ibkr.error);
  fail = false;
  const restarted = f.restart();
  await restarted.check(new Date(now.getTime() + 86400000));
  assert.equal(f.sent.length, 3);
  assert.deepEqual(f.sent[2], f.sent[0]);
  assert.equal(restarted.status().brokers.ibkr.pending, false);
  assert.equal(restarted.status().brokers.ibkr.error, null);
});

test('one pending broker cannot delay another broker on subsequent checks', async t => {
  const f = fixture(t);
  const gate = Promise.withResolvers<void>();
  const send = f.transport.send;
  f.transport.send = async (to, text, key) => {
    await send(to, text, key);
    if (key.includes(':ibkr:')) await gate.promise;
  };
  f.states.ibkr = 'login_required';
  const first = f.alerts.check(now);
  await new Promise(resolve => setImmediate(resolve));
  f.states.schwab = 'login_required';
  const second = f.alerts.check(now);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 2);
  assert.ok(f.store.state.loginAlerts?.schwab?.sentAt);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.sent.length, 2);
});

test('unknown, disabled and unpaired states do not send, and old settings cannot suppress login alerts', async t => {
  const f = fixture(t, '');
  f.states.ibkr = 'unknown';
  f.states.schwab = 'disabled';
  await f.alerts.check(now);
  f.states.ibkr = 'login_required';
  await f.alerts.check(now);
  assert.equal(f.sent.length, 0);
  f.store.state.lastHealth = 'auth';
  f.store.state.alerts = false;
  f.store.bind('ou_owner', f.store.pairingInfo()!.command.slice(3));
  await f.alerts.check(now);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, 'ou_owner');
  assert.equal(f.alerts.status().lastCheckAt, now.toISOString());
});
