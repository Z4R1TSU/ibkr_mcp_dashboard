import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchQuotes, researchSession, selectReference, tosResearchQuote } from '../server/research/quotes.js';
import type { Position } from '../shared/types.js';

const at = '2026-10-29T04:07:43Z', now = Date.parse(at);
const observation = (value: number, receivedAt = at) => ({ value, receivedAt, sourceTime: null });
function tosBody(symbol = 'GOOG') {
  return { disconnected: false, quote: { symbol, provider: 'thinkorswim', receivedAt: at,
    isDelayed: false, sourceTime: null,
    values: { MARK: 291.6, LAST: 291.54, LAST_RTH: 321.89, BID: 291.53, ASK: 291.6 },
    fieldTimes: Object.fromEntries(['MARK', 'LAST', 'LAST_RTH', 'BID', 'ASK'].map(k => [k, at])) } };
}

test('GOOG latest reference stays separate from the higher regular close, including overnight', () => {
  const q = tosResearchQuote('GOOG', tosBody(), now);
  assert.equal(q.reference.value, 291.6);
  assert.equal(q.reference.kind, 'mark');
  assert.equal(q.fields.regularLast?.value, 321.89);
  assert.equal(q.fields.regularClose, undefined);
  assert.equal(q.fields.last?.value, 291.54);
  assert.equal(q.reference.sourceTime, null);
  assert.deepEqual(researchSession(new Date(at)), { session: 'overnight', expectedSettledDate: '2026-10-28' });
});

test('receipt heartbeats cannot refresh price fields; close is never a latest-price fallback', () => {
  const body = tosBody();
  body.quote.receivedAt = '2026-10-29T05:00:00Z';
  assert.throws(() => tosResearchQuote('GOOG', body, Date.parse(body.quote.receivedAt)), /过期/);
  assert.throws(() => selectReference({ regularClose: observation(321.89) }, true, now));
  assert.equal(selectReference({ last: observation(321.89), bid: observation(291), ask: observation(292) }, true, now).value, 291.5);
  assert.throws(() => selectReference({ bid: observation(292), ask: observation(291) }, true, now));
  assert.throws(() => tosResearchQuote('GOOG', tosBody('GOOGL'), now), /不匹配/);
});

test('source timestamps, delay flags and market calendar retain their meaning', () => {
  const body = tosBody(); body.quote.isDelayed = true;
  assert.equal(tosResearchQuote('GOOG', body, now).status, 'DELAYED');
  assert.equal(selectReference({ last: { ...observation(321.89), sourceTime: '2026-10-28T20:00:00Z' },
    bid: observation(291), ask: observation(292) }, false, now).kind, 'midpoint');
  assert.equal(researchSession(new Date('2026-11-27T18:16:00Z')).expectedSettledDate, '2026-11-27');
  assert.equal(researchSession(new Date('2026-11-27T18:14:00Z')).expectedSettledDate, '2026-11-25');
  assert.equal(researchSession(new Date('2026-12-25T22:00:00Z')).expectedSettledDate, '2026-12-24');
  assert.equal(researchSession(new Date('2026-03-09T13:31:00Z')).session, 'regular');
});

test('research actively requests unheld symbols; IB is attempted only after a failed primary', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-quotes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'api-key.json'), JSON.stringify({ key: 'fixture' }), { mode: 0o600 });
  const calls: string[] = [];
  let primaryOk = true;
  const request = (async (url: any) => {
    calls.push(new URL(url).pathname + new URL(url).search);
    return primaryOk ? Response.json(tosBody()) : new Response('', { status: 503 });
  }) as typeof fetch;
  const client = { call: async (name: string, args: any) => {
    calls.push(name);
    if (name === 'search_contracts') return { results: [{ symbol: args.query, country_code: 'US',
      underlying_contract_id: 123, sections: [{ security_type: 'STK' }] }] };
    assert.equal(args.contract_id, 123);
    return { last: { price: 291.54, is_close: false, ts: now / 1000 },
      'top-status': { status: 'REALTIME' }, 'bid-ask': { bid: 291.53, ask: 291.6 } };
  } };
  const source = new ResearchQuotes(client, () => [], { TOS_DATA_DIR: directory }, request, () => now);
  const signal = new AbortController().signal;
  assert.equal((await source.get('GOOG', signal)).quote?.reference.value, 291.6);
  assert.deepEqual(calls, ['/v1/quote?symbol=GOOG']);
  primaryOk = false; calls.length = 0;
  const fallback = await source.get('GOOG', signal);
  assert.equal(fallback.quote?.source, 'ibkr');
  assert.equal(fallback.quote?.reference.value, 291.54);
  assert.equal(fallback.failures.length, 1);
  assert.deepEqual(calls, ['/v1/quote?symbol=GOOG', 'search_contracts', 'get_price_snapshot']);
});

test('held contract is reused; ambiguous contracts and dual failures produce no fabricated quote', async () => {
  const calls: string[] = [];
  const client = { call: async (name: string, args: any) => {
    calls.push(name);
    if (name === 'search_contracts') return { results: [
      { symbol: 'GOOG', country_code: 'US', underlying_contract_id: 1, sections: [{ security_type: 'STK' }] },
      { symbol: 'GOOG', country_code: 'US', underlying_contract_id: 2, sections: [{ security_type: 'STK' }] }] };
    assert.equal(args.contract_id, 123);
    return { last: { price: 321.89, is_close: true }, plprice: { price: 321.89 } };
  } };
  const position = { symbol: 'GOOG', currency: 'USD', kind: 'stock', id: 123 } as Position;
  const env = { TOS_DATA_DIR: '/nonexistent-research-test' };
  const source = new ResearchQuotes(client, () => [position], env, fetch, () => now);
  const signal = new AbortController().signal;
  const result = await source.get('GOOG', signal);
  assert.equal(result.quote, null);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(calls, ['get_price_snapshot']);
  calls.length = 0;
  assert.equal((await new ResearchQuotes(client, () => [], env, fetch, () => now).get('GOOG', signal)).quote, null);
  assert.deepEqual(calls, ['search_contracts']);
});
