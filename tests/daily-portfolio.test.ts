import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DailyData, type DailyFacts } from '../server/daily-data.js';
import { DailyReports, dailyFactsText } from '../server/daily-report.js';
import { normalizeSnapshot } from '../server/normalize.js';
import { CompatibleModel } from '../server/bot/model.js';
import { readModelConfig } from '../server/bot/config.js';
import type { DashboardState } from '../shared/types.js';
import { dailyFixture } from './daily-fixture.js';
import type { PerformanceSource } from '../server/performance-source.js';
import { FrozenPresenceStore } from '../server/discord/frozen.js';

function accountFixture(): DashboardState {
  const time = '2026-09-26T03:00:00Z';
  const positions = Array.from({ length: 82 }, (_, i) => ({
    contract_id: i + 1, contract_description: 'STOCK' + i, asset_class: 'STK',
    currency: 'USD', position: 2, market_value: 200, market_price: 100, unrealized_pnl: 10,
  }));
  positions.push({ contract_id: 83, contract_description: 'Short put [XYZ 261016P00040000 100]',
    asset_class: 'OPT', currency: 'USD', position: -2, market_value: -400, market_price: 2, unrealized_pnl: -50 },
  { contract_id: 84, contract_description: 'EURBOND', asset_class: 'BOND',
    currency: 'EUR', position: 3, market_value: 300, market_price: 100, unrealized_pnl: 0 });
  return { snapshot: normalizeSnapshot({ positions }, { currency: 'USD', net_liquidation: 100000,
    total_cash_value: 80000, excess_liquidity: 60000 }, { balances: [{ currency: 'USD', cash_balance: 80000 }] },
    { positions: time, summary: time, balances: time }), quotes: {}, history: [],
    status: { connected: true, stale: false, refreshing: false, lastAttempt: time, nextAttempt: null,
      error: null, quoteError: null, pollSeconds: 60, staleSeconds: 180, quoteBatchSize: 4 } };
}

function factsWithPortfolio(state = accountFixture()): DailyFacts {
  return { ...dailyFixture(), portfolio: { snapshot: state.snapshot, deltaRisk: state.deltaRisk,
    status: { connected: state.status.connected, stale: state.status.stale } } };
}

const background = (context: string) => JSON.parse(context.slice(context.lastIndexOf('\n') + 1));

test('the model request receives the complete portfolio while report text remains concise', async t => {
  const dir = directory(t), facts = factsWithPortfolio();
  let request: any;
  const model = new CompatibleModel(readModelConfig({
    MODEL_BASE_URL: 'https://model.example/v1', MODEL_NAME: 'fixture', MODEL_API_KEY: 'fake',
  }), async (_url, init) => {
    request = JSON.parse(JSON.parse(String(init!.body)).messages.at(-1).content);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '账户存在卖出期权敞口，需关注相关标的波动。' } }] });
  });
  const text = await new DailyReports(dir, model, async () => facts).generate();
  assert.equal(model.diagnostics?.error, null);
  assert.doesNotMatch(request.accountContext.summary, /尚无账户快照/);
  assert.match(request.accountContext.summary, /持仓数：84/);
  const { portfolio, basis } = background(request.accountContext.extraContext);
  assert.deepEqual(portfolio.snapshot, facts.portfolio!.snapshot);
  assert.equal(portfolio.snapshot.positions[81].symbol, 'STOCK81');
  assert.equal(portfolio.snapshot.positions[81].navWeight, 0.002);
  assert.equal(portfolio.snapshot.positions[82].quantity, -2);
  assert.equal(portfolio.snapshot.positions[82].option.strike, 40);
  assert.equal(portfolio.snapshot.positions[83].kind, 'other');
  assert.equal(portfolio.snapshot.positions[83].navWeight, null);
  assert.equal(portfolio.snapshot.account.cash, 80000);
  assert.equal(portfolio.snapshot.analysis.options[0].strikeNotional, 8000);
  assert.match(basis, /比例为小数/);
  assert.match(request.question, /不能当作昨日全程持仓/);
  assert.match(request.question, /不得将已有信息说成缺失/);
  assert.match(request.question, /不逐项复述完整持仓清单/);
  assert.doesNotMatch(text, /STOCK81|EURBOND|账户分析背景|navWeight/);
  assert.equal(dailyFactsText(facts), dailyFactsText(dailyFixture()));
  const file = path.join(dir, 'daily-reports', facts.date + '.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).facts.portfolio, JSON.parse(JSON.stringify(facts.portfolio)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file.replace('.json', '.txt'), 'utf8'), text);
});

function directory(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-portfolio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('daily data captures every asset without additional account reads or losing holdings with missing prices', async () => {
  const state = accountFixture(), original = structuredClone(state.snapshot);
  const calls: string[] = [];
  const client = { call: async (name: string, args?: Record<string, unknown>) => {
    calls.push(name);
    if (name === 'search_contracts') return { results: [{ symbol: args!.query, country_code: 'US',
      sections: [{ security_type: 'STK' }], underlying_contract_id: 1000 }] };
    assert.equal(name, 'get_price_history');
    if (args!.contract_id === 1) throw new Error('Missing stock daily bars');
    return { time: ['2026-09-24T13:30:00Z', '2026-09-25T13:30:00Z'], open: [100, 100], close: [100, 101] };
  } };
  const performance = { get: async () => {
    state.snapshot!.positions[0].quantity = 99;
    return { portfolio_measure: 'TWR', accounts: { one: { base_currency: 'USD', periods: {
      '7D': { frequency: 'D', start_date: '20260923', start_nav: 1000,
        dates: ['20260924', '20260925'], nav: [1000, 1010], cps: [0, 0.01] },
    } } } };
  } } as PerformanceSource;
  const facts = await new DailyData(client, performance).get(state, new Date('2026-09-26T03:00:00Z'));
  assert.deepEqual(facts.portfolio!.snapshot, original);
  assert.deepEqual(facts.portfolio!.status, { connected: true, stale: false });
  assert.equal(facts.portfolio!.snapshot!.positions.length, 84);
  assert.equal(facts.holdings.length, 4);
  assert.match(facts.warnings.join(), /STOCK0/);
  assert.ok(calls.every(name => ['search_contracts', 'get_price_history'].includes(name)));
});

test('changed portfolio refreshes the report cache without changing sealed daily returns', async t => {
  const dir = directory(t), facts = { ...factsWithPortfolio(), accountId: 'one' };
  let calls = 0, now = new Date(facts.generatedAt);
  const store = new FrozenPresenceStore(dir);
  const model = { configured: true, name: 'fake', answer: async () => '复盘版本 ' + (++calls) };
  const makeReports = () => new DailyReports(dir, model, async () => facts, value => store.recordReport(value, now));
  const first = await makeReports().generate();
  now = new Date('2026-09-26T08:00:00Z'); facts.generatedAt = now.toISOString();
  assert.equal(await makeReports().generate(), first);
  assert.equal(calls, 1);
  facts.portfolio!.snapshot!.positions[0].quantity = 4;
  facts.portfolio!.snapshot!.positions[0].navWeight = 0.004;
  facts.account.endNav = 500;
  facts.account.returnPct = -50;
  const second = await makeReports().generate();
  assert.equal(calls, 2);
  assert.match(second, /复盘版本 2/);
  assert.match(second, /账户日收益率：\+1\.0000%/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'daily-reports', facts.date + '.json'), 'utf8'));
  assert.equal(saved.facts.portfolio.snapshot.positions[0].quantity, 4);
  assert.equal(saved.facts.account.endNav, 1010);
  const restored = new FrozenPresenceStore(dir);
  const sealed = restored.get({ portfolio_measure: 'TWR', accounts: { one: { base_currency: 'USD' } } }, facts.date, now)!;
  assert.equal(sealed.returnPct, 1);
  assert.equal(sealed.endNav, 1010);
});

test('model failure does not print the private portfolio context in the fallback', async t => {
  const facts = factsWithPortfolio();
  facts.benchmarks = []; facts.holdings = [];
  facts.warnings = ['行情缺失'];
  const model = new CompatibleModel(readModelConfig({
    MODEL_BASE_URL: 'https://model.example/v1', MODEL_NAME: 'fixture', MODEL_API_KEY: 'fake',
  }), async () => Response.json({}, { status: 503 }));
  const report = await new DailyReports(directory(t), model, async () => facts).generate();
  assert.equal(model.diagnostics?.error, 'http');
  assert.match(report, /昨日盈亏/);
  assert.match(report, /行情缺失/);
  assert.doesNotMatch(report, /账户分析背景|STOCK81|navWeight/);
});

test('missing, empty and stale backgrounds remain distinct without blocking reports', async t => {
  const stale = accountFixture();
  stale.status = { ...stale.status, connected: false, stale: true };
  const missing = accountFixture();
  missing.snapshot = null; missing.status.stale = true;
  const empty = accountFixture();
  empty.snapshot!.positions = [];
  for (const [label, facts] of [
    ['legacy', dailyFixture()], ['missing', factsWithPortfolio(missing)],
    ['empty', factsWithPortfolio(empty)], ['stale', factsWithPortfolio(stale)],
  ] as const) await t.test(label, async sub => {
    const model = { configured: true, name: 'fake', answer: async (_q: string, state: DashboardState, _p: string, context = '') => {
      assert.deepEqual(state.snapshot, facts.portfolio?.snapshot ?? null);
      assert.equal(state.status.stale, facts.portfolio?.status.stale ?? true);
      assert.equal(state.status.connected, facts.portfolio?.status.connected ?? false);
      assert.deepEqual(background(context).portfolio, facts.portfolio ? JSON.parse(JSON.stringify(facts.portfolio)) : null);
      return '根据可用数据进行复盘。';
    } };
    const report = await new DailyReports(directory(sub), model, async () => facts).generate();
    assert.match(report, /昨日盈亏/);
    assert.match(report, /根据可用数据进行复盘/);
    assert.doesNotMatch(report, /账户分析背景|STOCK81/);
  });
});
