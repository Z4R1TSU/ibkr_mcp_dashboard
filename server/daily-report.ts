import fs from 'node:fs';
import path from 'node:path';
import type { DailyFacts } from './daily-data.js';
import type { AccountModel } from './bot/model.js';
import type { DashboardState } from '../shared/types.js';
import { createHash } from 'node:crypto';

const number = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number, decimals = 2) => (n > 0 ? '+' : '') + n.toFixed(decimals) + '%';

export function dailyFactsText(f: DailyFacts): string {
  const a = f.account;
  const lines = [
    '美股交易日报｜' + f.date,
    (a.flowMismatch ? '账户净值变动：' : '昨日盈亏（净值变动口径）：') + number(a.navChange) + ' ' + a.currency,
    '账户日收益率：' + (a.returnPct === null ? '暂缺' : signed(a.returnPct, 4) + '（' + a.measure + '）'),
    '净值：' + number(a.startNav) + ' → ' + number(a.endNav) + ' ' + a.currency + '，比较日期 ' + a.previousDate + ' → ' + a.date,
  ];
  if (a.flowMismatch) lines.push('净值差与日收益率不一致，可能包含资金进出或其他调整，不能直接把净值增加当成交易盈利。');
  lines.push('', '大盘价格表现（较前收；括号内为常规时段开盘至收盘）：');
  for (const row of f.benchmarks) lines.push(row.label + ' ' + row.symbol + '：' + (row.dayChangePct === null ? '前收暂缺' : signed(row.dayChangePct)) + '（' + signed(row.sessionChangePct) + '）');
  lines.push('', '当前持仓股票前五的该日价格表现：');
  for (const row of f.holdings) lines.push(row.symbol + '：' + (row.dayChangePct === null ? '前收暂缺' : signed(row.dayChangePct)) + '（场内 ' + signed(row.sessionChangePct) + '）');
  for (const row of [...f.benchmarks, ...f.holdings]) if (row.corporateActions.length) lines.push(row.symbol + ' 当日有公司行动，价格涨跌包含其影响。');
  if (f.warnings.length) lines.push('', '数据缺项：' + f.warnings.join('；'));
  return lines.join('\n');
}

export function basicMarketSummary(f: DailyFacts): string {
  const known = f.benchmarks.filter(row => row.dayChangePct !== null);
  const up = known.filter(row => row.dayChangePct! > 0).length;
  const stocks = [...f.holdings].filter(row => row.dayChangePct !== null).sort((a, b) => b.dayChangePct! - a.dayChangePct!);
  const parts = ['已取得行情的 ' + known.length + ' 类大盘 ETF 中，' + up + ' 类上涨、' + (known.length - up) + ' 类持平或下跌。'];
  if (stocks.length) parts.push('持仓股票样本中，' + stocks[0].symbol + ' 表现最强（' + signed(stocks[0].dayChangePct!) + '），' + stocks.at(-1)!.symbol + ' 表现最弱（' + signed(stocks.at(-1)!.dayChangePct!) + '）。');
  parts.push('这些是价格表现，不据此推断未经核实的新闻原因，也不等同于各头寸的当日损益贡献。');
  return parts.join('\n');
}

export class DailyReports {
  constructor(private readonly directory: string, private readonly model: AccountModel, private readonly load: () => Promise<DailyFacts>) {}
  async generate(preferences = ''): Promise<string> {
    const facts = await this.load();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(facts.date)) throw new Error('日报日期无效');
    const dir = path.join(this.directory, 'daily-reports');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, facts.date + '.json');
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...facts, generatedAt: '', preferences })).digest('hex');
    if (fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.fingerprint === fingerprint && typeof saved.text === 'string') return saved.text;
      } catch { /* Regenerate an incomplete local report. */ }
    }
    const base = dailyFactsText(facts);
    let analysis = basicMarketSummary(facts);
    if (this.model.configured) {
      const state = { snapshot: null, status: { connected: true, stale: false } } as DashboardState;
      const result = await this.model.answer('写上一美股常规交易日的行情复盘。只依据extraContext中的历史数据，不需要即时账户快照。比较大盘和持仓样本的强弱，说明有证据的观察；不要编造新闻原因，不要把当前持仓的价格表现当作昨日头寸盈亏贡献，不重复数字表或数据来源。', state, preferences, base);
      if (!this.model.diagnostics?.error) analysis = result;
    }
    const text = base + '\n\n行情复盘\n' + analysis;
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ facts, fingerprint, text }), { mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.writeFileSync(path.join(dir, facts.date + '.txt'), text, { mode: 0o600 });
    return text;
  }
}
