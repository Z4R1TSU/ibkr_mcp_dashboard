import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteActivity } from '../server/discord/remote-activity.js';
import { DiscordBridge } from '../server/discord/bridge.js';
import { PresenceData } from '../server/discord/data.js';
import type { DashboardState } from '../shared/types.js';
import type { PresenceActivity, PresenceSummary } from '../shared/discord.js';

test('a data-loss update arriving during an RPC send clears the late write', async () => {
  let activity: PresenceActivity | null = { details: 'old', state: 'old' };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const sent: (PresenceActivity | null)[] = [];
  const connection = { connected: false, connect: async () => { connection.connected = true; },
    send: async (value: PresenceActivity | null) => {
      if (value) { entered.resolve(); await release.promise; }
      sent.push(value);
    }, close: async () => { connection.connected = false; } };
  const bridge = new DiscordBridge(() => ({ enabled: true, applicationId: '123456789012345678', startDate: '' }),
    () => activity, () => connection);
  bridge.start();
  try {
    await entered.promise;
    activity = null;
    const cleared = bridge.sync();
    release.resolve();
    await cleared;
    assert.deepEqual(sent.map(value => value?.details ?? null), ['old', null]);
    assert.equal(bridge.connected, false);
  } finally { release.resolve(); await bridge.stop(); }
});

test('unchanged activities are reasserted after suspension even if IPC still claims connected', async () => {
  let clock = 100000;
  const sent: (PresenceActivity | null)[] = [];
  const connection = { connected: false, connect: async () => { connection.connected = true; },
    send: async (value: PresenceActivity | null) => { sent.push(value); },
    close: async () => { connection.connected = false; } };
  const bridge = new DiscordBridge(() => ({ enabled: true, applicationId: '123456789012345678', startDate: '2026-03-31' }),
    () => ({ details: 'account', state: '10/12 -3.58%' }), () => connection, () => clock);
  bridge.start();
  try {
    await bridge.sync();
    assert.equal(sent.length, 1);
    clock += 10000;
    await bridge.sync();
    assert.equal(sent.length, 1);
    clock += 50000;
    await bridge.sync();
    assert.equal(sent.length, 2);
    clock += 3 * 3600000;
    await bridge.sync();
    assert.equal(sent.length, 3);
    assert.equal(sent.at(-1)?.state, '10/12 -3.58%');
  } finally { await bridge.stop(); }
});

const now = Date.parse('2026-10-13T03:00:00Z');

test('weekend and pre-close sync retain the last completed trading day', async () => {
  const state = { snapshot: { fetchedAt: '2026-10-09T21:00:00Z', account: { nav: 1100, currency: 'USD' } },
    status: { connected: true, stale: true } } as DashboardState;
  const raw = { portfolio_measure: 'TWR', accounts: { only: { base_currency: 'USD', periods: {
    LOCAL: { frequency: 'D', start_date: '20261007', start_nav: 1000,
      dates: ['20261008', '20261009', '20261012'], nav: [1000, 1100, 1210], cps: [0, 0.1, 0.21] },
  } } } };
  let marketDate = '2026-10-09';
  const source = new PresenceData(() => state, async () => raw, async () => marketDate);
  const cache = new RemoteActivity();
  for (const [time, expected] of [
    ['2026-10-11T16:00:00Z', '2026-10-09'],
    ['2026-10-12T12:00:00Z', '2026-10-09'],
    ['2026-10-12T15:00:00Z', '2026-10-09'],
    ['2026-10-12T21:00:00Z', '2026-10-12'],
  ]) {
    const clock = new Date(time);
    marketDate = expected;
    await source.refresh(clock);
    const value = source.summary('2026-03-31', clock, 1000);
    assert.equal(value.performance?.date, expected, time);
    assert.equal(cache.accept(value, 'app', clock.getTime()), true, time);
    assert.ok(cache.get(clock.getTime()), time);
    assert.ok(!value.warnings.some(warning => /较旧|回退/.test(warning)), time);
  }
});
const summary = (time = now, date = '2026-10-12') => ({
  version: 1, currency: 'USD', stale: false, generatedAt: new Date(time).toISOString(),
  accountAsOf: new Date(time).toISOString(), performance: { date },
  activity: { details: 'current account', state: date },
}) as PresenceSummary;

test('replayed responses cannot renew the activity lease, and resumed sync needs a fresh response', () => {
  const cache = new RemoteActivity();
  const current = summary();
  cache.accept(current, 'app', now);
  assert.equal(cache.get(now + 45000), null);
  assert.equal(cache.accept(current, 'app', now + 45000), false);
  assert.equal(cache.get(now + 45000), null);
  assert.equal(cache.accept(summary(now + 3600000), 'app', now + 3600000), true);
  assert.ok(cache.get(now + 3600000));
});

test('fresh server responses can keep a correctly dated snapshot visible for hours', () => {
  const cache = new RemoteActivity();
  for (let elapsed = 0; elapsed <= 3 * 3600000; elapsed += 15000) {
    const current = { ...summary(now + elapsed), stale: true, accountAsOf: new Date(now).toISOString(),
      activity: { details: '快照 10/13 11:00 · account', state: '10/12 -3.58%' } };
    assert.equal(cache.accept(current, 'app', now + elapsed), true);
    assert.equal(cache.get(now + elapsed)?.state, '10/12 -3.58%');
  }
});

test('remote sync rejects date regression and allows same-day corrections', () => {
  const cache = new RemoteActivity();
  const current = summary();
  assert.equal(cache.accept(current, 'app', now), true);
  assert.equal(cache.accept(summary(now + 1000, '2026-09-30'), 'app', now + 1000), false);
  assert.equal(cache.get(now + 1000), current.activity);
  const oldAccount = { ...summary(now + 1000), accountAsOf: '2026-09-30T03:00:00Z' };
  assert.equal(cache.accept(oldAccount, 'app', now + 1000), false);
  cache.disconnect();
  assert.equal(cache.accept(oldAccount, 'app', now + 1000), false);
  const revised = { ...summary(now + 2000), activity: { details: 'revised', state: '10/12 +1.00%' } };
  assert.equal(cache.accept(revised, 'app', now + 2000), true);
  assert.equal(cache.get(now + 2000), revised.activity);
  const replayed = { ...revised, generatedAt: new Date(now + 1000).toISOString(), activity: current.activity };
  assert.equal(cache.accept(replayed, 'app', now + 3000), false);
  assert.equal(cache.get(now + 3000), revised.activity);
});
