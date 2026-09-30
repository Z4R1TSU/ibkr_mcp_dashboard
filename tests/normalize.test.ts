import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, normalizeQuote, parseOption } from '../server/normalize.js';

const sources = { positions: '2026-09-25T10:00:00.000Z', summary: '2026-09-25T10:00:01.000Z', balances: '2026-09-25T10:00:02.000Z' };
const summary = { currency: 'USD', net_liquidation: 11000, total_cash_value: 1000, equity_with_loan_value: 12000, excess_liquidity: 6000, leverage: '1.02' };
const balances = { balances: [{ currency: 'BASE', unrealized_pnl: 100, realized_pnl: 0, cash_balance: 1000 }, { currency: 'USD', unrealized_pnl: 100, realized_pnl: 0, cash_balance: 1000 }] };
function stock(overrides: Record<string, unknown> = {}) { return { contract_id: 1, contract_description: 'TEST', asset_class: 'STK', currency: 'USD', position: 100, market_price: 100, market_value: 10000, unrealized_pnl: 100, ...overrides }; }
function option(overrides: Record<string, unknown> = {}) { return { contract_id: 2, contract_description: 'TEST OCT2026 100 C [TEST  261016C00100000 100]', currency: 'USD', position: -1, market_price: 2, market_value: -200, unrealized_pnl: 20, ...overrides }; }
function normalize(rows: unknown[]) { return normalizeSnapshot({ positions: rows }, summary, balances, sources); }

test('null asset class options are parsed using explicit expiry, strike, and multiplier', () => {
  const result = normalize([option({ asset_class: null })]);
  assert.equal(result.positions[0].kind, 'option');
  assert.deepEqual(result.positions[0].option, { underlying: 'TEST', expiry: '2026-10-16', right: 'C', strike: 100, multiplier: 100 });
  assert.equal(result.analysis.optionValue, -200);
});
test('BASE aggregate is not added to currency rows', () => {
  const result = normalize([stock()]);
  assert.equal(result.account.unrealizedPnl, 100);
  assert.equal(result.account.realizedPnl, 0);
  assert.equal(result.balances.length, 1);
  assert.equal(result.analysis.residual, 0);
});
test('missing values remain unknown and propagate to totals', () => {
  const result = normalize([stock({ market_value: undefined, unrealized_pnl: null })]);
  assert.equal(result.positions[0].value, null);
  assert.equal(result.analysis.stockValue, null);
  assert.equal(result.analysis.grossAbsoluteValue, null);
  assert.equal(result.analysis.totalPositionPnl, null);
  assert.equal(result.analysis.topThreeWeight, null);
});
test('multiple currencies are not summed without verified FX conversion', () => {
  const result = normalize([stock(), stock({ contract_id: 3, currency: 'EUR' })]);
  assert.equal(result.analysis.allBaseCurrency, false);
  assert.equal(result.analysis.netPositionValue, null);
  assert.equal(result.positions[1].navWeight, null);
  assert.equal(result.analysis.shortPutNotional, null);
});
test('stock cover is allocated once across calls by expiry', () => {
  const result = normalize([stock(), option(), option({ contract_id: 3, contract_description: 'TEST NOV2026 100 C [TEST  261120C00100000 100]' })]);
  assert.deepEqual(result.analysis.options.map(value => value.matchedShares), [100, 0]);
  assert.deepEqual(result.analysis.options.map(value => value.unmatchedShares), [0, 100]);
});
test('put commitment is gross strike cash, not option market value', () => {
  const result = normalize([option({ contract_description: 'TEST OCT2026 100 P [TEST  261016P00100000 100]' })]);
  assert.equal(result.analysis.shortPutNotional, 10000);
  assert.equal(result.analysis.shortPutCashGap, 9000);
  assert.equal(result.positions[0].value, -200);
});
test('unknown option terms prevent a complete short put total', () => {
  const result = normalize([option({ asset_class: 'OPT', contract_description: 'Unparsed option' })]);
  assert.equal(result.analysis.shortPutNotional, null);
});
test('future options are not incorrectly treated as stock options', () => {
  const result = normalize([option({ asset_class: 'FOP' })]);
  assert.equal(result.positions[0].kind, 'other');
  assert.equal(result.positions[0].option, null);
  assert.equal(result.analysis.shortPutNotional, null);
});
test('unknown stock quantities do not become an invented zero share cover', () => {
  const result = normalize([stock({ position: null }), option()]);
  assert.equal(result.analysis.options[0].matchedShares, null);
  assert.equal(result.analysis.options[0].unmatchedShares, null);
});
test('invalid dates and absent multipliers cannot be inferred', () => {
  assert.equal(parseOption('TEST [TEST  260231P00100000 100]'), null);
  assert.equal(parseOption('TEST [TEST  261016P00100000]'), null);
  assert.equal(parseOption('TEST [TEST  261016P00100000 0]'), null);
});
test('empty portfolio is valid; duplicate ids and missing NAV fail closed', () => {
  assert.equal(normalize([]).analysis.netPositionValue, 0);
  assert.throws(() => normalize([stock(), stock()]));
  assert.throws(() => normalizeSnapshot({ positions: [] }, {}, balances, sources));
});
test('quote hyphenated keys, frozen status, and absent trade time are retained', () => {
  const quote = normalizeQuote(2, { 'top-status': { status: 'FROZEN_DELAYED' }, last: { price: 2.5, is_close: true }, 'bid-ask': { bid: 2, ask: 3 }, plprice: { price: 2.4 } }, sources.positions);
  assert.equal(quote.status, 'FROZEN_DELAYED');
  assert.equal(quote.lastTradeAt, null);
  assert.equal(quote.mark, 2.4);
  assert.equal(quote.bid, 2);
  assert.equal(quote.lastIsClose, true);
});
test('missing quote price is not filled with zero or previous close', () => {
  const quote = normalizeQuote(1, { last: { ts: 1790338901, price: null }, 'top-status': { status: 'REALTIME' } }, sources.summary);
  assert.equal(quote.last, null);
  assert.equal(quote.mark, null);
  assert.equal(quote.lastTradeAt, new Date(1790338901000).toISOString());
  assert.notEqual(quote.lastTradeAt, quote.fetchedAt);
});
test('margin buffer denominator is equity with loan, not NAV or buying power', () => {
  assert.equal(normalize([stock()]).analysis.marginBufferRatio, 0.5);
});
