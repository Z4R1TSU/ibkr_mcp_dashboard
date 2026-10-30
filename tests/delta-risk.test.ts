import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDeltaRisk, deltaRiskView, retainCompleteRisk } from '../server/delta-risk.js';
import { normalizeSnapshot } from '../server/normalize.js';
import type { DeltaInput, Position, RiskObservation } from '../shared/types.js';
const now = Date.parse('2026-10-23T14:00:00Z'), time = new Date(now).toISOString();
const obs = (value: number): RiskObservation => ({ value, receivedAt: time, sourceTime: null, source: 'thinkorswim', status: 'REALTIME' });
const stock = (id: number, quantity: number, symbol = 'AAPL') => ({ id, quantity, symbol, description: symbol, kind: 'stock', currency: 'USD', option: null } as Position);
const option = (id: number, quantity: number, right: 'C' | 'P', symbol = 'AAPL') => ({ ...stock(id, quantity, symbol), kind: 'option', option: { underlying: symbol, expiry: '2026-12-18', strike: 100, right, multiplier: 100 } } as Position);
function fixture(positions: Position[], deltas: Record<number, number> = {}, prices: Record<string, number> = {}) {
  const snapshot = normalizeSnapshot({ positions: [] }, { currency: 'USD', net_liquidation: 10000 }, { balances: [] }, { positions: time, summary: time, balances: time });
  snapshot.positions = positions;
  const inputs: Record<number, DeltaInput> = Object.fromEntries(positions.map(p => [p.id, { price: obs(prices[p.symbol] ?? 100), delta: p.kind === 'option' ? obs(deltas[p.id]) : null, reason: null }]));
  return { snapshot, inputs, run: () => calculateDeltaRisk(snapshot, inputs, now, 180) };
}
test('covered calls reduce portfolio leverage before absolute aggregation', () => {
  const risk = fixture([stock(1, 100), option(2, -1, 'C')], { 2: .3 }).run();
  assert.equal(risk.leverage, .7);
  assert.equal(risk.rows[1].equivalentShares, -30);
  assert.equal(risk.underlyings[0].equivalentShares, 70);
});
test('short puts gain exposure on falling stock; protective puts and spreads offset', () => {
  assert.equal(fixture([option(1, -1, 'P')], { 1: -.2 }).run().coveredGrossExposure, 2000);
  assert.equal(fixture([option(1, -1, 'P')], { 1: -.5 }, { AAPL: 90 }).run().coveredGrossExposure, 4500);
  assert.equal(fixture([stock(1, 100), option(2, 1, 'P')], { 2: -.4 }).run().leverage, .6);
  assert.equal(fixture([option(1, -1, 'P'), option(2, 1, 'P')], { 1: -.5, 2: -.2 }).run().leverage, .3);
  const naked = fixture([stock(1, 100), option(2, -3, 'C')], { 2: .5 }).run();
  assert.equal(naked.leverage, .5); assert.equal(naked.netLeverage, -.5);
});
test('different underlyings never cancel in the main metric', () => {
  const risk = fixture([stock(1, 100), stock(2, -80, 'MSFT')]).run();
  assert.equal(risk.coveredGrossExposure, 18000);
  assert.equal(risk.coveredNetExposure, 2000);
  assert.equal(risk.leverage, 1.8); assert.equal(risk.netLeverage, .2);
});
test('missing, unverified, stale and invalid contracts cannot produce whole-account leverage', () => {
  const f = fixture([stock(1, 100), option(2, -1, 'C')], { 2: .3 });
  f.inputs[2].delta = null;
  assert.equal(f.run().leverage, null); assert.equal(f.run().covered, 1);
  assert.equal(f.run().underlyings[0].complete, false);
  f.inputs[2].delta = { ...obs(.3), receivedAt: new Date(now - 120001).toISOString() };
  assert.equal(f.run().leverage, null);
  f.inputs[2].delta = obs(-.3); assert.equal(f.run().leverage, null);
  f.inputs[2].delta = obs(0); assert.equal(f.run().leverage, 1);
  f.snapshot.positions[1].option!.multiplier = 10; assert.equal(f.run().leverage, null);
});
test('missing or stale NAV and foreign currencies block leverage; cash-only is zero', () => {
  const f = fixture([stock(1, 100)]);
  for (const nav of [null, 0, -1]) { f.snapshot.account.nav = nav; assert.equal(f.run().leverage, null); }
  f.snapshot.account.nav = 10000;
  f.snapshot.sources.summary = '2026-10-23T13:00:00Z'; assert.equal(f.run().leverage, null);
  f.snapshot.sources.summary = time;
  f.snapshot.positions[0].currency = 'EUR'; assert.equal(f.run().leverage, null);
  assert.equal(fixture([]).run().leverage, 0);
});
test('expired readings become dated references without extending their timestamps', () => {
  const risk = fixture([stock(1, 100)]).run();
  assert.equal(deltaRiskView(risk, now + 120001)?.status, 'reference');
  assert.equal(deltaRiskView(risk, now + 120001)?.leverage, 1);
  assert.equal(deltaRiskView(risk, now + 120001)?.calculatedAt, time);
  const reference = deltaRiskView(risk, Date.parse('2026-10-24T12:00:00Z'))!;
  assert.equal(reference.status, 'historical'); assert.equal(reference.leverage, 1);
  assert.equal(reference.navAt, time);
  assert.equal(deltaRiskView(reference, Date.parse('2026-10-26T14:00:00Z'))?.status, 'reference');
});
test('failed refresh retains a coherent reference without mixing new NAV or prices', () => {
  const f = fixture([stock(1, 100), option(2, -1, 'C')], { 2: .3 });
  const complete = f.run();
  f.snapshot.account.nav = 8000;
  f.inputs[1].price = obs(90);
  f.inputs[2].delta = null;
  const attempt = { ...f.run(), requiresLogin: true, reason: '嘉信需要重新登录' };
  const display = retainCompleteRisk(attempt, complete);
  assert.equal(display.status, 'reference');
  assert.equal(display.leverage, .7);
  assert.equal(display.nav, 10000);
  assert.equal(display.rows[0].price?.value, 100);
  assert.equal(display.rows[1].delta, .3);
  assert.equal(display.validUntil, complete.validUntil);
  assert.equal(display.requiresLogin, true);
  assert.equal(display.latestAttempt?.covered, 1);
  f.inputs[2].delta = obs(.4);
  assert.equal(retainCompleteRisk(f.run(), complete).status, 'current');
  f.snapshot.positions[0].quantity = 200;
  f.inputs[2].delta = null;
  assert.equal(retainCompleteRisk(f.run(), complete).leverage, null);
});
test('four hours of alternating delays and outages never blank an unchanged portfolio', () => {
  const f = fixture([stock(1, 100), option(2, -1, 'C')], { 2: .3 });
  let previous = f.run();
  for (let minute = 1; minute <= 240; minute++) {
    const at = now + minute * 60000, stamp = new Date(at).toISOString();
    f.snapshot.sources = { positions: stamp, summary: stamp, balances: stamp };
    f.snapshot.account.nav = 10000 + minute;
    f.inputs[1].price = { ...obs(100), receivedAt: stamp };
    f.inputs[2].price = { ...obs(100), receivedAt: stamp };
    const outage = minute % 5 === 0 || minute >= 60 && minute <= 90;
    f.inputs[2].delta = outage ? null : { ...obs(.3), receivedAt: stamp };
    const attempt = calculateDeltaRisk(f.snapshot, f.inputs, at, 180);
    const display = retainCompleteRisk(attempt, previous);
    assert.notEqual(display.leverage, null);
    if (outage) {
      assert.equal(display.status, 'reference');
      assert.equal(display.nav, previous.nav);
      assert.equal(display.calculatedAt, previous.calculatedAt);
      assert.equal(display.latestAttempt?.covered, 1);
    } else previous = attempt;
  }
});
