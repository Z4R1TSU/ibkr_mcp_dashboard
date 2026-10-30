import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dailyPerformance, completedDay } from '../server/daily-performance.js';
import { dailyBars, marketDay } from '../server/daily-market.js';
import { DailyReports, dailyFactsText } from '../server/daily-report.js';
import { dailyFixture } from './daily-fixture.js';

const performance = (end = 1045) => ({ portfolio_measure: 'TWR', accounts: { account: {
  base_currency: 'USD', periods: { '7D': { frequency: 'D', start_date: '20260923', start_nav: 1000,
    dates: ['20260924', '20260925'], nav: [1100, end], cps: [0.1, 0.045] } },
} } });

test('daily P&L uses adjacent NAVs and geometrically links daily TWR', () => {
  const day = dailyPerformance(performance(), '2026-09-25');
  assert.equal(day.navChange, -55);
  assert.ok(Math.abs(day.returnPct! + 5) < 1e-10);
  assert.equal(day.flowMismatch, false);
  assert.equal(day.previousDate, '2026-09-24');
  const deposit = dailyPerformance(performance(1245), '2026-09-25');
  assert.equal(deposit.flowMismatch, true);
  assert.match(dailyFactsText({ ...dailyFixture(), account: deposit }), /不能直接把净值增加当成交易盈利/);
  assert.throws(() => dailyPerformance(performance(), '2026-09-28'));
});

test('US session selection handles Beijing mornings and daylight saving time', () => {
  assert.equal(completedDay('2026-09-28', new Date('2026-09-29T03:00:00Z')), true);
  assert.equal(completedDay('2026-09-28', new Date('2026-09-28T19:30:00Z')), false);
  assert.equal(completedDay('2026-12-07', new Date('2026-12-07T20:30:00Z')), false);
  assert.equal(completedDay('2026-12-07', new Date('2026-12-07T21:30:00Z')), true);
  assert.equal(completedDay('2026-09-25', new Date('2026-09-28T03:00:00Z')), true);
});
test('market review distinguishes close-to-close and regular-session price changes', () => {
  const bars = dailyBars({ time: ['2026-09-24T13:30:00Z', '2026-09-25T13:30:00Z'],
    open: [99, 102], close: [100, 105], corp_actions: [] });
  const row = marketDay(bars, '2026-09-25', 'SPY', '标普500 ETF')!;
  assert.ok(Math.abs(row.dayChangePct! - 5) < 1e-10);
  assert.ok(Math.abs(row.sessionChangePct - (105 / 102 - 1) * 100) < 1e-10);
  assert.equal(marketDay(bars, '2026-09-26', 'SPY', 'test'), null);
});
test('daily report contains P&L and market recap and saves a private copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-daily-test-'));
  try {
    let calls = 0;
    const model = { configured: true, name: 'fake', answer: async (_question: string, _state: unknown, _preferences: string, context: string) => {
      calls++;
      assert.doesNotMatch(context, /场内|开盘至收盘|0\.50%/);
      return '大盘上涨，持仓样本表现更强。';
    } };
    const reports = new DailyReports(dir, model, async () => dailyFixture());
    const text = await reports.generate();
    assert.match(text, /昨日盈亏/);
    assert.match(text, /10.00 USD/);
    assert.match(text, /大盘价格表现/);
    assert.match(text, /行情复盘/);
    assert.match(text, /SPY：\+1\.00%\n/);
    assert.match(text, /AAPL：\+2\.00%(?:\n|$)/);
    assert.doesNotMatch(text, /场内|开盘至收盘|0\.50%/);
    assert.doesNotMatch(text, /数据源：.*MCP/);
    assert.equal(await reports.generate(), text);
    assert.equal(calls, 1);
    assert.equal(fs.statSync(path.join(dir, 'daily-reports', '2026-09-25.txt')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('version 3 reports cached without account background are regenerated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-daily-cache-'));
  try {
    const facts = dailyFixture();
    const fingerprint = createHash('sha256').update(JSON.stringify({ version: 3, ...facts, generatedAt: '', preferences: '' })).digest('hex');
    fs.mkdirSync(path.join(dir, 'daily-reports'));
    fs.writeFileSync(path.join(dir, 'daily-reports', facts.date + '.json'), JSON.stringify({ facts, fingerprint, text: '旧日报（场内 +1.00%）' }));
    const reports = new DailyReports(dir, { configured: false, name: 'unused', answer: async () => '' }, async () => facts);
    const text = await reports.generate();
    assert.match(text, /美股交易日报/);
    assert.doesNotMatch(text, /场内|开盘至收盘/);
    assert.equal(fs.readFileSync(path.join(dir, 'daily-reports', facts.date + '.txt'), 'utf8'), text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
