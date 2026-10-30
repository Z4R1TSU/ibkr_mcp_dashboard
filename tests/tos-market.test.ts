import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TosMarket, tosSymbol } from '../server/tos-market.js';
import { Collector } from '../server/collector.js';
import type { IbkrClient } from '../server/ibkr.js';
import { DailyData } from '../server/daily-data.js';
import type { Position } from '../shared/types.js';
const position = { id: 1, symbol: 'AAPL', kind: 'stock', currency: 'USD', option: null } as Position;
const now = Date.parse('2026-10-21T14:00:00Z');
const time = new Date(now).toISOString();
test('login status distinguishes invalid credentials from startup, outage and damaged caches', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-auth-'));
  let clock = now;
  const market = new TosMarket(directory, () => clock);
  const file = path.join(directory, 'market-cache.json');
  const write = (state: string, connected = false, lastFrameAt: string | null = time) => {
    fs.writeFileSync(file, JSON.stringify({ status: { state, connected, lastFrameAt } }), { mode: 0o600 });
    clock += 1001;
  };
  try {
    assert.equal(market.authStatus(), 'unknown');
    for (const state of ['starting', 'connecting', 'reconnecting']) {
      write(state);
      assert.equal(market.authStatus(), 'unknown');
    }
    write('login_required');
    assert.equal(market.authStatus(), 'login_required');
    assert.equal(market.requiresLogin(), true);
    write('connected', true, new Date(clock).toISOString());
    assert.equal(market.authStatus(), 'ready');
    clock += 21000;
    assert.equal(market.authStatus(), 'unknown');
    fs.writeFileSync(file, '{invalid');
    clock += 1001;
    assert.equal(market.authStatus(), 'unknown');
    write('login_required');
    fs.chmodSync(file, 0o644);
    assert.equal(market.authStatus(), 'unknown');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('daily benchmarks prefer Schwab and use original contract/history calls on a miss', async () => {
  let available = true;
  const calls: string[] = [];
  const bars = [{ date: '2026-10-20', time, open: 100, close: 101, corporateActions: [], source: 'thinkorswim' }];
  const market = { history: () => available ? bars : null } as unknown as TosMarket;
  const client = { call: async (name: string) => {
    calls.push(name);
    if (name === 'search_contracts') return { results: [{ symbol: 'SPY', country_code: 'US',
      sections: [{ security_type: 'STK' }], underlying_contract_id: 1 }] };
    return { time: ['2026-10-20T13:30:00Z'], open: [100], close: [101] };
  } } as unknown as IbkrClient;
  const daily = new DailyData(client, undefined, market);
  assert.equal(await daily.latestCompletedDate(new Date(now)), '2026-10-20');
  assert.equal(calls.length, 0);
  available = false;
  assert.equal(await daily.latestCompletedDate(new Date(now)), '2026-10-20');
  assert.deepEqual(calls, ['search_contracts', 'get_price_history']);
});
function brokerFixture(onQuote: () => void) {
  return { oauth: { vault: { get: () => ({ oauth: { tokens: {} } }) } }, disconnect: async () => {},
    readAccount: async () => ({
      positions: { positions: [{ contract_id: 1, contract_description: 'AAPL', asset_class: 'STK', currency: 'USD',
        position: 1, market_price: 100, market_value: 100, unrealized_pnl: 1 }] },
      summary: { currency: 'USD', net_liquidation: 1000 }, balances: { balances: [] },
      sources: { positions: time, summary: time, balances: time },
    }),
    call: async () => { onQuote(); return { last: { price: 199 }, 'top-status': { status: 'REALTIME' } }; },
  } as unknown as IbkrClient;
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-market-'));
  const cache = { status: { connected: true, lastFrameAt: time },
    quotes: { AAPL: { symbol: 'AAPL', receivedAt: time, isDelayed: false, values: { MARK: 200, LAST: 199, BID: 199, ASK: 201 } } },
    snapshotQuotes: {} };
  const write = () => fs.writeFileSync(path.join(directory, 'market-cache.json'), JSON.stringify(cache), { mode: 0o600 });
  write();
  return { directory, cache, write };
}
test('collector falls back to IB without changing account valuation', async () => {
  const f = fixture();
  let available = true, brokerQuotes = 0;
  const preferred = new TosMarket(f.directory, () => now).quote(position);
  const market = { watch() {}, quote: () => available ? preferred : null, reason: '嘉信离线' } as unknown as TosMarket;
  const collector = new Collector(brokerFixture(() => brokerQuotes++), f.directory, market);
  try {
    await collector.refresh();
    assert.equal(collector.view().quotes[1].source, 'thinkorswim');
    assert.equal(collector.view().snapshot?.positions[0].price, 100);
    assert.equal(collector.view().snapshot?.account.nav, 1000);
    assert.equal(brokerQuotes, 0);
    available = false;
    await collector.refresh();
    assert.equal(brokerQuotes, 1);
    assert.equal(collector.view().quotes[1].source, 'ibkr');
    assert.equal(collector.view().quotes[1].last, 199);
    assert.equal(collector.view().quotes[1].fallbackReason, '嘉信离线');
  } finally {
    await collector.pause();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
test('quote uses Schwab only when current and matched; outages do not masquerade as fresh data', () => {
  const f = fixture();
  try {
    let clock = now;
    const market = new TosMarket(f.directory, () => clock);
    assert.equal(market.quote(position)?.source, 'thinkorswim');
    assert.equal(market.quote(position)?.mark, 200);
    clock += 21000;
    assert.equal(market.quote(position), null);
    f.cache.status.lastFrameAt = new Date(clock).toISOString();
    f.cache.status.connected = false; f.write();
    clock += 1001;
    assert.equal(market.quote(position), null);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('only standard USD options are mapped, preserving strike and right', () => {
  const p = { ...position, kind: 'option', option: { underlying: 'APP', expiry: '2026-12-18', right: 'P', strike: 250, multiplier: 100 } } as Position;
  assert.equal(tosSymbol(p), '.APP261218P250');
  assert.equal(tosSymbol({ ...p, option: { ...p.option!, strike: 250.5 } }), '.APP261218P250.5');
  assert.equal(tosSymbol({ ...p, option: { ...p.option!, multiplier: 10 } }), null);
  assert.equal(tosSymbol({ ...p, option: { ...p.option!, expiry: '2026-02-31' } }), null);
  assert.equal(tosSymbol({ ...p, currency: 'EUR' }), null);
});
test('daily history requires a verified basis and the latest completed trading date', () => {
  const f = fixture();
  try {
    const market = new TosMarket(f.directory, () => now);
    fs.mkdirSync(path.join(f.directory, 'history'));
    const value = { symbol: 'AAPL', interval: '1d', session: 'regular', receivedAt: time,
      adjustment: 'unknown', bars: [
        { date: '2026-10-19', timestamp: Date.parse('2026-10-19T13:30:00Z'), open: 190, close: 195 },
        { date: '2026-10-20', timestamp: Date.parse('2026-10-20T13:30:00Z'), open: 195, close: 200 }] };
    const write = () => fs.writeFileSync(path.join(f.directory, 'history/AAPL.json'), JSON.stringify(value), { mode: 0o600 });
    write();
    assert.equal(market.history('AAPL'), null);
    value.adjustment = 'split'; write();
    assert.equal(market.history('AAPL')?.[1].source, 'thinkorswim');
    value.bars.pop(); write();
    assert.equal(market.history('AAPL'), null);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('Delta uses verified exact contracts and independent field times, never row heartbeats', () => {
  const f = fixture();
  let clock = now;
  const p = { ...position, kind: 'option', quantity: -1, option: { underlying: 'AAPL', expiry: '2026-12-18', right: 'C', strike: 250, multiplier: 100 } } as Position;
  const cache = f.cache as any;
  cache.quotes.AAPL.fieldTimes = { MARK: time };
  cache.holdingGreeks = { '.AAPL261218C250': { symbol: '.AAPL261218C250', deltaBasis: 'per-share-feed-v1', multiplier: 100,
    sharesPerContract: 100, contract: { ...p.option }, values: { DELTA: .3 }, fieldTimes: { DELTA: time }, isDelayed: true } };
  f.write();
  const market = new TosMarket(f.directory, () => clock);
  try {
    assert.equal(market.deltaInput(p).delta?.value, .3);
    assert.equal(market.deltaInput(p).delta?.status, 'DELAYED');
    assert.equal(market.deltaInput(p).price?.value, 200);
    clock += 120001;
    cache.status.lastFrameAt = new Date(clock).toISOString();
    cache.holdingGreeks['.AAPL261218C250'].receivedAt = cache.status.lastFrameAt;
    cache.quotes.AAPL.fieldTimes.MARK = cache.status.lastFrameAt;
    f.write();
    assert.equal(market.deltaInput(p).delta, null);
    assert.equal(market.deltaInput(p).price?.value, 200);
    cache.holdingGreeks['.AAPL261218C250'].fieldTimes.DELTA = cache.status.lastFrameAt;
    cache.holdingGreeks['.AAPL261218C250'].contract.strike = 251;
    clock += 1001; f.write();
    assert.equal(market.deltaInput(p).delta, null);
  } finally { fs.rmSync(f.directory, { recursive: true }); }
});
test('views and heartbeat reads never resample; explicit refresh and closed history are coherent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = fixture();
  let price = 200, quoteCalls = 0, riskCalls = 0;
  const market = { watch() {}, reason: '', quote: () => { quoteCalls++; return { id: 1, source: 'thinkorswim', mark: price, fetchedAt: time, status: 'REALTIME' }; },
    deltaInput: () => { riskCalls++; return { price: { value: price, receivedAt: time, sourceTime: null, source: 'thinkorswim', status: 'REALTIME' }, delta: null, reason: null }; } } as unknown as TosMarket;
  const collector = new Collector(brokerFixture(() => {}), f.directory, market);
  try {
    await collector.refresh();
    const count = quoteCalls;
    assert.equal(collector.view().deltaRisk?.leverage, .2);
    price = 500;
    for (let i = 0; i < 20; i++) collector.view();
    assert.equal(quoteCalls, count); assert.equal(riskCalls, 1);
    assert.equal(collector.view().quotes[1].mark, 200);
    const duringRefresh: unknown[] = [];
    collector.on('change', state => duringRefresh.push(state.deltaRisk?.leverage));
    await collector.refresh();
    assert.ok(duringRefresh.length > 0);
    assert.ok(duringRefresh.every(value => value !== null && value !== undefined));
    assert.equal(collector.view().deltaRisk?.leverage, .5);
    t.mock.timers.tick(Date.parse('2026-10-24T12:00:00Z') - now);
    await collector.refresh();
    const historical = collector.view().deltaRisk!;
    assert.equal(historical.status, 'reference'); assert.equal(historical.leverage, .5);
    assert.equal(riskCalls, 3);
    const restored = new Collector(brokerFixture(() => {}), f.directory, market);
    assert.equal(restored.view().deltaRisk?.status, 'historical');
    t.mock.timers.tick(2 * 86400000);
    assert.equal(restored.view().deltaRisk?.status, 'reference');
    assert.equal(restored.view().deltaRisk?.leverage, .5);
  } finally { await collector.pause(); fs.rmSync(f.directory, { recursive: true }); }
});
test('closed markets calculate changed holdings, persist complete results and refresh unchanged positions', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-delta-'));
  let stockCount = 15, nav = 100000, missingDelta = false;
  const stamp = () => new Date().toISOString();
  const client = {
    oauth: { vault: { get: () => ({ oauth: { tokens: {} } }) } }, disconnect: async () => {},
    readAccount: async () => ({
      positions: { positions: [...Array.from({ length: stockCount }, (_, index) => ({ contract_id: index + 1,
        contract_description: 'S' + String.fromCharCode(65 + index), asset_class: 'STK', currency: 'USD', position: 100,
        market_price: 100, market_value: 10000 })),
        { contract_id: 100, contract_description: 'SA [SA 261218C00100000 100]', asset_class: 'OPT', currency: 'USD',
          position: -1, market_price: 2, market_value: -200 }] },
      summary: { currency: 'USD', net_liquidation: nav }, balances: { balances: [] },
      sources: { positions: stamp(), summary: stamp(), balances: stamp() },
    }),
    call: async () => assert.fail('quotes should come from the market fixture'),
  } as unknown as IbkrClient;
  const observation = (value: number) => ({ value, receivedAt: stamp(), sourceTime: null, source: 'thinkorswim', status: 'REALTIME' });
  const market = { watch() {}, requiresLogin: () => false, quote: (p: Position) => ({ id: p.id, mark: 100, source: 'thinkorswim', fetchedAt: stamp(), status: 'REALTIME' }),
    deltaInput: (p: Position) => ({ price: observation(100), delta: p.kind === 'option' && !missingDelta ? observation(.3) : null, reason: null }),
  } as unknown as TosMarket;
  const collector = new Collector(client, directory, market);
  try {
    await collector.refresh();
    assert.equal(collector.view().deltaRisk?.status, 'current');
    assert.equal(collector.view().deltaRisk?.total, 16);
    assert.equal(collector.view().deltaRisk?.leverage, 1.47);
    t.mock.timers.tick(Date.parse('2026-10-29T06:00:00Z') - now);
    stockCount = 14;
    await collector.refresh();
    const closed = collector.view().deltaRisk!;
    assert.equal(closed.status, 'historical');
    assert.equal(closed.covered, 15); assert.equal(closed.total, 15);
    assert.equal(closed.leverage, 1.37); assert.equal(closed.netLeverage, 1.37);
    assert.match(closed.reason!, /休市参考/);
    nav = 200000;
    t.mock.timers.tick(60000);
    await collector.refresh();
    const updated = collector.view().deltaRisk!;
    assert.equal(updated.leverage, .685);
    assert.notEqual(updated.calculatedAt, closed.calculatedAt);
    const restored = new Collector(client, directory, market);
    assert.equal(restored.view().deltaRisk?.leverage, .685);
    assert.equal(restored.view().deltaRisk?.status, 'historical');
    missingDelta = true;
    t.mock.timers.tick(60000);
    await collector.refresh();
    assert.equal(collector.view().deltaRisk?.status, 'reference');
    assert.equal(collector.view().deltaRisk?.calculatedAt, updated.calculatedAt);
    assert.equal(collector.view().deltaRisk?.latestAttempt?.covered, 14);
    stockCount = 13;
    await collector.refresh();
    assert.equal(collector.view().deltaRisk?.leverage, null);
    assert.equal(collector.view().deltaRisk?.status, 'incomplete');
    t.mock.timers.tick(Date.parse('2026-10-29T08:00:00Z') - Date.now());
    assert.equal(restored.view().deltaRisk?.status, 'reference');
    missingDelta = false;
    await collector.refresh();
    assert.equal(collector.view().deltaRisk?.status, 'current');
    assert.equal(collector.view().deltaRisk?.leverage, .635);
  } finally { await collector.pause(); fs.rmSync(directory, { recursive: true }); }
});
