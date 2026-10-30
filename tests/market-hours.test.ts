import test from 'node:test';
import assert from 'node:assert/strict';
import { marketActive, nextBackgroundRead, nextMarketOpen } from '../server/market-hours.js';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const SIX_HOURS = 21600000;

test('the active window is 04:00-20:00 New York on US trading days, in both DST regimes', () => {
  // Monday 2026-10-19, daylight time (UTC-4).
  assert.equal(marketActive(at('2026-10-19T07:59:59Z')), false);
  assert.equal(marketActive(at('2026-10-19T08:00:00Z')), true);
  assert.equal(marketActive(at('2026-10-19T23:59:59Z')), true);
  assert.equal(marketActive(at('2026-10-20T00:00:00Z')), false);
  // Monday 2026-11-02, standard time (UTC-5).
  assert.equal(marketActive(at('2026-11-02T08:59:59Z')), false);
  assert.equal(marketActive(at('2026-11-02T09:00:00Z')), true);
  assert.equal(marketActive(at('2026-11-03T00:59:59Z')), true);
  assert.equal(marketActive(at('2026-11-03T01:00:00Z')), false);
  // Weekend and Thanksgiving (2026-11-26) stay closed all day.
  assert.equal(marketActive(at('2026-10-17T16:00:00Z')), false);
  assert.equal(marketActive(at('2026-11-26T16:00:00Z')), false);
});

test('the next open skips weekends and holidays and follows the DST change', () => {
  assert.equal(iso(nextMarketOpen(at('2026-10-20T01:00:00Z'))), '2026-10-20T08:00:00.000Z');
  // Friday evening to Monday morning.
  assert.equal(iso(nextMarketOpen(at('2026-10-24T01:00:00Z'))), '2026-10-26T08:00:00.000Z');
  // Clocks fall back on Sunday 2026-11-01: Monday opens an hour later in UTC.
  assert.equal(iso(nextMarketOpen(at('2026-10-31T16:00:00Z'))), '2026-11-02T09:00:00.000Z');
  // Thanksgiving Wednesday evening to Friday.
  assert.equal(iso(nextMarketOpen(at('2026-11-26T02:00:00Z'))), '2026-11-27T09:00:00.000Z');
  // Before 04:00 on a trading day, the open is the same morning.
  assert.equal(iso(nextMarketOpen(at('2026-10-19T03:00:00Z'))), '2026-10-19T08:00:00.000Z');
});

test('active reads keep their own cadence; closed reads share wall-clock slots and resume at the open', () => {
  const active = at('2026-10-19T14:00:00Z');
  assert.equal(nextBackgroundRead(active, 60000, SIX_HOURS), active + 60000);
  // Saturday: every reader lands on the same six-hour UTC boundary.
  assert.equal(iso(nextBackgroundRead(at('2026-10-17T13:00:00Z'), 60000, SIX_HOURS)), '2026-10-17T18:00:00.000Z');
  assert.equal(iso(nextBackgroundRead(at('2026-10-17T13:59:00Z'), 300000, SIX_HOURS)), '2026-10-17T18:00:00.000Z');
  assert.equal(iso(nextBackgroundRead(at('2026-10-17T18:00:00Z'), 60000, SIX_HOURS)), '2026-10-18T00:00:00.000Z');
  // Weeknight: the next slot (06:00Z) comes before the 08:00Z open.
  assert.equal(iso(nextBackgroundRead(at('2026-10-20T01:00:00Z'), 60000, SIX_HOURS)), '2026-10-20T06:00:00.000Z');
  // Close to the open, the open wins over the next slot.
  assert.equal(iso(nextBackgroundRead(at('2026-10-20T06:30:00Z'), 60000, SIX_HOURS)), '2026-10-20T08:00:00.000Z');
  // A whole weekend costs a handful of reads, not thousands.
  let reads = 0;
  for (let t = at('2026-10-17T00:00:00Z'); t < at('2026-10-19T08:00:00Z'); t = nextBackgroundRead(t, 60000, SIX_HOURS)) reads++;
  assert.ok(reads <= 10, String(reads));
});
