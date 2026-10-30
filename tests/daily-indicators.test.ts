import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MarketIndicators, parseTrendonify, parseFearGreed, fearGreedLabel, type ValuationPage } from '../server/daily-indicators.js';
import { DailyReports } from '../server/daily-report.js';
import { dailyFixture } from './daily-fixture.js';

const page = (forward = false, date = 'October 16, 2026'): ValuationPage => ({
  heading: 'NASDAQ-100 ' + (forward ? 'Forward ' : '') + 'PE Ratio',
  text: 'NASDAQ-100 ' + (forward ? 'FORWARD ' : '') + 'PE RATIO\n' + (forward ? '19.85' : '30.7') + '\nLast Updated:\n' + date,
  headers: ['Time Period', 'Median PE Ratio', 'Percentile Rank', 'Valuation'],
  rows: [['5 Year', '32.69', '30', 'Undervalued'], ['10 Year', '29.99', forward ? '12.5' : '53.3', 'Fair Value'], ['20 Year', '24.3', '74.2', 'Overvalued']],
});
const fearPage = (date = '2026-10-16') => '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({
  props: { pageProps: { data: { fgiData: { fgi: [{ date, now: 18 }, { date: '2026-10-20', now: 99 }],
    fgi_crypto: [{ date, now: 88 }] } } } },
}) + '</script>';
const pages = () => ({ 'pe-ratio': page(), 'forward-pe-ratio': page(true) });

test('reads the ten-year percentile from the matching index and earnings measure', () => {
  assert.equal(parseTrendonify(page()).percentile10y, 53.3);
  assert.equal(parseTrendonify(page(true), true).percentile10y, 12.5);
  assert.equal(parseTrendonify(page()).date, '2026-10-16');
  assert.throws(() => parseTrendonify(page(true)));
  assert.throws(() => parseTrendonify({ ...page(), rows: [page().rows[0]] }));
  assert.throws(() => parseTrendonify({ ...page(), rows: [['10 Year', '29', '101', 'Fair Value']] }));
  assert.throws(() => parseTrendonify({ ...page(), heading: 'S&P 500 PE Ratio' }));
});

test('CNN parsing excludes crypto, future dates, and invalid observations', () => {
  const reading = parseFearGreed(fearPage(), '2026-10-16');
  assert.equal(reading.value, 18);
  assert.equal(reading.date, '2026-10-16');
  assert.equal(fearGreedLabel(reading.value), '极度恐惧');
  assert.throws(() => parseFearGreed(fearPage(), '2026-10-15'));
  assert.throws(() => parseFearGreed('<html>Verification required</html>', '2026-10-16'));
  assert.throws(() => parseFearGreed(fearPage().replace('"now":18', '"now":null'), '2026-10-16'));
  assert.equal(parseFearGreed(fearPage().replace('"now":18', '"now":0'), '2026-10-16').value, 0);
});

test('concurrent reads share scraping and the private cache survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indicators-test-'));
  let calls = 0;
  const sources = { fearGreed: async () => fearPage(), valuations: async () => { calls++; return pages(); } };
  const clock = () => Date.parse('2026-10-17T03:00:00Z');
  try {
    const service = new MarketIndicators(dir, sources, clock);
    const [first, second] = await Promise.all([service.get('2026-10-16'), service.get('2026-10-16')]);
    assert.deepEqual(first, second);
    assert.equal(first.forwardPe?.value, 19.85);
    assert.equal(calls, 1);
    assert.deepEqual(await new MarketIndicators(dir, sources, clock).get('2026-10-16'), first);
    assert.equal(calls, 1);
    assert.equal(fs.statSync(path.join(dir, 'daily-market-indicators.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failures retain dated recent data but reject future or overly old readings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indicators-stale-'));
  let now = Date.parse('2026-10-17T03:00:00Z'), fail = false;
  const sources = {
    fearGreed: async () => { if (fail) throw new Error('offline'); return fearPage(); },
    valuations: async () => { if (fail) throw new Error('offline'); return pages(); },
  };
  try {
    const service = new MarketIndicators(dir, sources, () => now);
    const past = await service.get('2026-10-15');
    assert.equal(past.pe, null);
    assert.equal(past.forwardPe, null);
    await service.get('2026-10-16');
    fail = true;
    now += 3 * 86400000;
    const fallback = await service.get('2026-10-19');
    assert.equal(fallback.pe?.date, '2026-10-16');
    assert.match(fallback.warnings.join(), /缓存/);
    now += 10 * 86400000;
    const expired = await service.get('2026-10-29');
    assert.equal(expired.pe, null);
    assert.equal(expired.forwardPe, null);
    assert.equal(expired.fearGreed, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reports seal account facts before scraping and include indicators in model context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indicators-report-'));
  let sealed = false;
  const service = new MarketIndicators(dir, {
    fearGreed: async () => fearPage('2026-09-25'),
    valuations: async () => ({ 'pe-ratio': page(false, 'September 25, 2026'), 'forward-pe-ratio': page(true, 'September 25, 2026') }),
  });
  try {
    const model = { configured: true, name: 'fake', answer: async (_q: string, _s: unknown, _p: string, context = '') => {
      assert.match(context, /CNN.*18\/100/);
      assert.match(context, /Forward PE.*19\.85.*12\.5%/);
      assert.doesNotMatch(context, /场内/);
      return '大盘与估值观察。';
    } };
    const reports = new DailyReports(dir, model, async () => dailyFixture(), facts => { sealed = true; return facts; },
      async date => { assert.equal(sealed, true); return service.get(date); });
    const text = await reports.generate();
    assert.match(text, /昨日盈亏.*10\.00 USD/);
    assert.match(text, /PE（TTM）.*30\.70.*53\.3%/);
    assert.equal(await reports.generate(), text);
    const failed = new DailyReports(dir, { configured: false, name: 'fake', answer: async () => '' }, async () => dailyFixture(),
      facts => facts, async () => { throw new Error('browser unavailable'); });
    const fallback = await failed.generate();
    assert.match(fallback, /昨日盈亏.*10\.00 USD/);
    assert.match(fallback, /情绪与估值数据暂不可用/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
