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

test('a later fetch of September performance cannot replace an October return', async () => {
  const now = new Date('2026-10-13T03:00:00Z');
  const state = { snapshot: { fetchedAt: now.toISOString(), account: { nav: 1100, currency: 'USD' } },
    status: { connected: true, stale: false } } as DashboardState;
  const raw = history();
  raw.accounts.only.periods.YTD.dates = ['20260930', '20261012'];
  raw.accounts.only.periods.YTD.cps = [-0.003, 0.1];
  raw.accounts.only.periods.YTD.nav = [997, 1100];
  let response = raw;
  const source = new PresenceData(() => state, async () => response, async () => '2026-10-12');
  await source.refresh(now);
  const expected = source.summary('2026-03-31', now).performance;
  response = structuredClone(raw);
  response.accounts.only.periods.YTD.dates.pop();
  response.accounts.only.periods.YTD.cps.pop();
  response.accounts.only.periods.YTD.nav.pop();
  await source.refresh(now);
  assert.deepEqual(source.summary('2026-03-31', now).performance, expected);
  assert.match(source.summary('2026-03-31', now).warnings.join(' '), /保留较新的 2026-10-12/);
});

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

test('stale account values stay labeled and unarchived returns do not become yesterday snapshots', async () => {
  const state = { snapshot: { fetchedAt: new Date().toISOString(), account: { nav: 2178, currency: 'USD' } },
    status: { connected: true, stale: false } } as DashboardState;
  const source = new PresenceData(() => state, async () => history(), async () => '2026-09-28');
  await source.refresh();
  assert.match(source.summary('2026-03-31').activity!.details, /总 \+8.90%/);
  assert.equal(source.summary('2026-03-31').activity!.largeImageKey, 'portfolio_flat');
  assert.equal(source.summary('2026-03-31').activity!.smallImageKey, 'trend_flat');
  state.status.stale = true;
  assert.match(source.summary('2026-03-31').activity!.details, /^旧值/);
  assert.equal(source.summary('2026-03-31').yesterday, null);
  assert.equal(source.summary('2026-03-31').performance!.date, '2026-09-28');
  assert.equal(source.summary('2026-03-31').nav, 2178);
  state.status.stale = false;
  state.snapshot!.account.currency = 'HKD';
  assert.equal(source.summary('2026-03-31').performance, null);
  assert.equal(source.summary('2026-03-31').activity!.largeImageKey, 'portfolio_flat');
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

test('an offline account without a snapshot publishes an explicit waiting activity', () => {
  const source = new PresenceData(() => ({ snapshot: null, status: { connected: false, stale: true } }) as DashboardState,
    async () => { throw new Error('offline'); }, async () => '2026-09-29');
  const value = source.summary('2026-03-31');
  assert.equal(value.activity!.largeImageKey, 'portfolio_flat');
  assert.match(value.activity!.name!, /等待数据/);
  assert.match(value.activity!.details, /净值 —/);
});

test('a failed performance refresh preserves the last dated return calculations', async () => {
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
  assert.match(value.activity!.details, /总 \+8.90%/);
  assert.equal(value.activity!.largeImageKey, 'portfolio_flat');
  assert.match(value.warnings.join(' '), /收益更新失败/);
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

test('mutable gains stay available for analysis without substituting an unarchived yesterday', async () => {
  for (const reason of ['calendar', 'offline', 'lag', 'stale', 'disconnected']) {
    const raw = Object.assign(history(), {
      local_archive: { latestDate: '2026-09-28', providerLatest: '2026-09-25', offline: reason === 'offline', records: 4 },
    });
    raw.accounts.only.periods.YTD.cps[3] = 1.331 * 1.1 - 1;
    raw.accounts.only.periods.YTD.nav[3] = 2662;
    const state = { snapshot: { fetchedAt: new Date().toISOString(), account: { nav: 2662, currency: 'USD' } },
      status: { connected: reason !== 'disconnected', stale: reason === 'stale' } } as DashboardState;
    const source = new PresenceData(() => state, async () => raw, async () => {
      if (reason === 'calendar') throw new Error('calendar unavailable');
      return reason === 'lag' ? '2026-09-29' : '2026-09-28';
    });
    await source.refresh();
    const value = source.summary('2025-03-31');
    assert.ok(value.warnings.length, reason);
    assert.equal(value.performance!.totalReturnPct, null, reason);
    assert.ok(Math.abs(value.performance!.dailyReturnPct! - 10) < 1e-8, reason);
    assert.equal(value.activity!.largeImageKey, 'portfolio_flat', reason);
    assert.equal(value.activity!.smallImageKey, 'trend_flat', reason);
    assert.equal(value.yesterday, null, reason);
    assert.match(value.activity!.state, /—$/, reason);
  }
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

test('capital totals work without cumulative TWR and keep the daily return separate', async () => {
  const state = { snapshot: { fetchedAt: new Date().toISOString(), account: { nav: 1500, currency: 'USD' } },
    status: { connected: true, stale: false } } as DashboardState;
  const source = new PresenceData(() => state, async () => history(), async () => '2026-09-28');
  await source.refresh();
  const value = source.summary('2025-03-31', undefined, 1000);
  assert.equal(value.total!.pnlUsd, 500);
  assert.equal(value.total!.returnPct, 50);
  assert.ok(value.activity!.details.endsWith('总 +50.00%'));
  assert.ok(Math.abs(value.performance!.dailyReturnPct! + 10) < 1e-8);
  assert.equal(value.activity!.largeImageKey, 'portfolio_flat');
  assert.equal(value.performance!.totalReturnPct, null);
  assert.ok(!value.warnings.some(warning => warning.includes('累计收益暂缺')));
  const withoutCost = source.summary('2025-03-31');
  assert.ok(withoutCost.warnings.some(warning => warning.includes('累计收益暂缺')));
});

test('capital totals survive unavailable performance and do not silently switch to TWR', async () => {
  const state = { snapshot: { fetchedAt: new Date().toISOString(), account: { nav: 600, currency: 'USD' } },
    status: { connected: true, stale: false } } as DashboardState;
  const source = new PresenceData(() => state, async () => { throw new Error('offline'); }, async () => '2026-09-28');
  await source.refresh();
  assert.equal(source.summary('2026-03-31', undefined, 1000).total!.returnPct, -40);
  state.snapshot!.account.nav = 1000;
  assert.ok(source.summary('2026-03-31', undefined, 1000).activity!.details.endsWith('总 +0.00%'));
  state.snapshot!.account.currency = 'HKD';
  const raw = history();
  raw.accounts.only.base_currency = 'HKD';
  const foreign = new PresenceData(() => state, async () => raw, async () => '2026-09-28');
  await foreign.refresh();
  const value = foreign.summary('2026-03-31', undefined, 1000);
  assert.equal(value.total, null);
  assert.ok(value.activity!.details.endsWith('总 —'));
  assert.ok(value.warnings.some(warning => warning.includes('美元账户净值')));
});
