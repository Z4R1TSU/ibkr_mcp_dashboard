import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { presencePerformance } from '../server/discord/performance.js';
import { daysInvested, PresenceData } from '../server/discord/data.js';
import { DiscordSettingsStore, validateSettings } from '../server/discord/settings.js';
import { DiscordBridge, bounded } from '../server/discord/bridge.js';
import { presenceArtwork } from '../server/discord/artwork.js';
import type { PresenceConnection } from '../server/discord/rpc.js';
import type { DashboardState } from '../shared/types.js';
import type { DiscordSettings, PresenceActivity } from '../shared/discord.js';

function history() {
  return { portfolio_measure: 'TWR', accounts: { only: { base_currency: 'USD', periods: {
    YTD: { frequency: 'D', start_date: '20260101', start_nav: 1000,
      dates: ['20260330', '20260331', '20260925', '20260928'],
      nav: [1100, 1210, 2420, 2178], cps: [0.1, 0.21, 0.331, 0.1979] },
  } } } };
}

test('artwork follows the daily return and treats zero or missing data as neutral', () => {
  assert.equal(presenceArtwork(1.25).largeImageKey, 'portfolio_up');
  assert.equal(presenceArtwork(-1.25).smallImageKey, 'trend_down');
  for (const value of [0, null, undefined, NaN]) {
    assert.equal(presenceArtwork(value).largeImageKey, 'portfolio_flat');
    assert.equal(presenceArtwork(value).smallImageKey, 'trend_flat');
  }
  assert.match(presenceArtwork(-3.13, '2026-09-28').smallImageText!, /2026-09-28.*下跌 -3.13%/);
});

test('presence return rebases TWR at the investment date and ignores deposits', () => {
  const result = presencePerformance(history(), '2026-09-28', '2026-03-31');
  assert.ok(Math.abs(result.value.totalReturnPct! - 8.9) < 1e-8);
  assert.ok(Math.abs(result.value.dailyReturnPct! + 10) < 1e-8);
  assert.equal(result.value.since, '2026-03-31');
});

test('presence never substitutes a partial period or MWR for cumulative TWR', () => {
  assert.equal(presencePerformance(history(), '2026-09-28', '2025-03-31').value.totalReturnPct, null);
  assert.equal(presencePerformance(history(), '2026-09-29', '2026-03-31').value.totalReturnPct, null);
  const input = history();
  input.accounts.only.periods.YTD.frequency = 'M';
  assert.equal(presencePerformance(input, '2026-09-28', '2026-03-31').value.totalReturnPct, null);
  input.portfolio_measure = 'MWR';
  assert.equal(presencePerformance(input, '2026-09-28', '2026-03-31').value.dailyReturnPct, null);
  const duplicate = history();
  duplicate.accounts.only.periods.YTD.dates[2] = '20260331';
  assert.equal(presencePerformance(duplicate, '2026-09-28', '2026-03-31').value.totalReturnPct, null);
});

test('investment days follow Beijing calendar dates and validate dates', () => {
  assert.equal(daysInvested('2026-03-31', new Date('2026-03-30T16:01:00Z')), 0);
  assert.equal(daysInvested('2026-03-31', new Date('2026-09-28T16:01:00Z')), 182);
  assert.equal(daysInvested('2026-02-30', new Date()), null);
  assert.throws(() => validateSettings({ enabled: true, applicationId: '', startDate: '2026-03-31' }));
});

test('IB first daily point includes return from the preceding valuation day', () => {
  const input = history();
  const p = input.accounts.only.periods.YTD;
  p.start_date = '20260330';
  p.dates = ['20260331', '20260925', '20260928'];
  p.cps = [-0.00364193, 0.331, 0.1979];
  p.nav = [1000, 2420, 2178];
  const result = presencePerformance(input, '2026-09-28', '2026-03-31');
  assert.ok(Math.abs(result.value.totalReturnPct! - 19.79) < 1e-8);
  assert.ok(Math.abs(result.value.dailyReturnPct! + 10) < 1e-8);
});

test('stale accounts retain dated grey snapshots and currency mismatches hide returns', async () => {
  const state = { snapshot: { fetchedAt: new Date().toISOString(), account: { nav: 2178, currency: 'USD' } },
    status: { connected: true, stale: false } } as DashboardState;
  const source = new PresenceData(() => state, async () => history(), async () => '2026-09-28');
  await source.refresh();
  assert.match(source.summary('2026-03-31').activity!.state, /累计 \+8.90%/);
  assert.equal(source.summary('2026-03-31').activity!.largeImageKey, 'portfolio_down');
  assert.equal(source.summary('2026-03-31').activity!.smallImageKey, 'trend_down');
  state.status.stale = true;
  assert.equal(source.summary('2026-03-31').activity!.largeImageKey, 'portfolio_flat');
  assert.match(source.summary('2026-03-31').activity!.name!, /账户快照/);
  assert.match(source.summary('2026-03-31').activity!.details, /2,178.00/);
  state.status.stale = false;
  state.snapshot!.account.currency = 'HKD';
  assert.equal(source.summary('2026-03-31').performance, null);
  assert.match(source.summary('2026-03-31').activity!.details, /HKD/);
});

test('Discord settings survive restart and invalid edits do not replace them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-settings-'));
  try {
    const store = new DiscordSettingsStore(dir, '2026-03-31');
    const settings = { enabled: true, applicationId: '123456789012345678', startDate: '2026-03-31', capitalUsd: 1000, capitalConfirmedAt: '2026-09-30' };
    store.save(settings);
    assert.throws(() => store.save({ ...settings, startDate: '2026-02-30' }));
    assert.throws(() => store.save({ ...settings, capitalUsd: 0 }));
    assert.deepEqual(new DiscordSettingsStore(dir).get(), settings);
    assert.equal(fs.statSync(path.join(dir, 'discord.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('an offline account without a snapshot still gets a neutral waiting activity', () => {
  const source = new PresenceData(() => ({ snapshot: null, status: { connected: false, stale: true } }) as DashboardState,
    async () => { throw new Error('offline'); }, async () => '2026-09-29');
  const value = source.summary('2026-03-31');
  assert.equal(value.activity!.largeImageKey, 'portfolio_flat');
  assert.match(value.activity!.name!, /等待数据/);
  assert.match(value.activity!.details, /账户 —/);
});

test('a failed performance refresh preserves the last dated return in grey', async () => {
  let failed = false;
  const state = { snapshot: { fetchedAt: new Date().toISOString(), account: { nav: 2178, currency: 'USD' } }, status: { connected: true, stale: false } } as DashboardState;
  const source = new PresenceData(() => state, async () => {
    if (failed) throw new Error('offline'); return history();
  }, async () => '2026-09-28');
  await source.refresh();
  failed = true;
  await source.refresh();
  const value = source.summary('2026-03-31');
  assert.equal(value.performance!.date, '2026-09-28');
  assert.match(value.activity!.state, /累计 \+8.90%/);
  assert.equal(value.activity!.largeImageKey, 'portfolio_flat');
});

test('bridge reconnects, coalesces updates, clears stale data and stops', async () => {
  let clock = 100000;
  const settings: DiscordSettings = { enabled: true, applicationId: '123456789012345678', startDate: '2026-03-31' };
  let activity: PresenceActivity | null = { details: 'one', state: 'first' };
  const sent: (PresenceActivity | null)[] = [];
  const connections: PresenceConnection[] = [];
  const create = () => {
    const c = { connected: false, connect: async () => { c.connected = true; },
      send: async (value: PresenceActivity | null) => { sent.push(value); }, close: async () => { c.connected = false; } };
    connections.push(c); return c;
  };
  const bridge = new DiscordBridge(() => settings, () => activity, create, () => clock);
  bridge.start();
  try {
    await bridge.sync();
    assert.equal(sent.length, 1);
    activity = { details: 'two', state: 'second' };
    await bridge.sync();
    assert.equal(sent.length, 1);
    clock += 60000;
    await bridge.sync();
    assert.equal(sent.length, 2);
    activity = null;
    await bridge.sync();
    assert.equal(sent.at(-1), null);
    await connections[0].close();
    activity = { details: 'reconnected', state: 'ok' };
    await bridge.sync();
    assert.equal(connections.length, 2);
    assert.equal(sent.at(-1)?.details, 'reconnected');
    settings.enabled = false;
    await bridge.reset();
    await bridge.sync();
    assert.equal(bridge.connected, false);
    assert.equal(sent.at(-1), null);
  } finally { await bridge.stop(); }
});

test('bridge catches rejected RPC writes and bounded calls cannot hang', async () => {
  const connection = { connected: true, connect: async () => undefined,
    send: async () => { throw new Error('write failed'); }, close: async () => { connection.connected = false; } };
  const settings = { enabled: true, applicationId: '123456789012345678', startDate: '2026-03-31' };
  const bridge = new DiscordBridge(() => settings, () => ({ details: 'x', state: 'y' }), () => connection);
  bridge.start();
  try { await bridge.sync(); assert.equal(bridge.connected, false); assert.match(bridge.error!, /同步失败/); }
  finally { await bridge.stop(); }
  await assert.rejects(bounded(new Promise(() => undefined), 5), /超时/);
});
