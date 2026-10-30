import fs from 'node:fs';
import path from 'node:path';
import type { DailyFacts } from './daily-data.js';
import type { AccountModel } from './bot/model.js';
import type { DashboardState } from '../shared/types.js';
import { createHash } from 'node:crypto';
import { fearGreedLabel, type DailyIndicators } from './daily-indicators.js';

const number = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number, decimals = 2) => (n > 0 ? '+' : '') + n.toFixed(decimals) + '%';
const REPORT_VERSION = 4;

const REVIEW_PROMPT = [
  '写上一美股交易日的行情复盘，结合已提供的完整账户背景，说明与实际仓位相关的市场表现、集中度和期权风险。',
  'extraContext 中的历史净值、TWR 和日线属于报告交易日；portfolio 是生成日报时最近取得的账户快照，不能当作昨日全程持仓。',
  '完整持仓以 portfolio.snapshot.positions 为准，包含股票、期权和其他资产；聊天摘要可能截断，前五只股票的行情表仅是价格样本，不是完整持仓。',
  '使用已提供的持仓、数量、市值、权重、现金和风险指标，不得将已有信息说成缺失或笼统声称不知道持仓。',
  '已有仓位可支持结构与风险观察；若缺少昨日持仓变化、成交或历史估值，则不能量化逐仓盈亏贡献，也不能认定它们造成了当日收益差异。',
  '只在缺项影响具体结论时简短指出具体缺项，不泛泛罗列缺失数据；快照不存在时才说明持仓背景不可用，过期时简短说明仍参考旧快照。',
  '涨跌仅使用收盘价较前收的口径，不讨论场内或开盘至收盘的涨跌；不要把未实现盈亏当作当日收益，不猜价格、汇率或新闻原因。',
  '正文只写有依据的关键结论与相关持仓，不逐项复述完整持仓清单，不重复数字表或数据来源。',
].join('\n');

function portfolioState(facts: DailyFacts): DashboardState {
  return { snapshot: facts.portfolio?.snapshot ?? null, deltaRisk: facts.portfolio?.deltaRisk,
    quotes: {}, history: [], status: { connected: facts.portfolio?.status.connected ?? false,
      stale: facts.portfolio?.status.stale ?? true, refreshing: false, lastAttempt: null, nextAttempt: null,
      error: null, quoteError: null, pollSeconds: 0, staleSeconds: 0, quoteBatchSize: 0 } };
}

function analysisContext(facts: DailyFacts, base: string): string {
  return base + '\n\n账户分析背景（仅供分析，不作为持仓清单输出）：\n' + JSON.stringify({
    basis: '当前账户背景与报告日收益分别计时。snapshot.fetchedAt 和 sources 是快照及各数据的采集时间。'
      + '金额沿用各项 currency，navWeight 和其他比例为小数，null 表示未知，不是零；未提供汇率时不跨币种相加。'
      + 'deltaRisk 仅按自身 status、calculatedAt 和覆盖范围解释，不作为昨日风险或盈亏。'
      + '个别日线缺失不表示该持仓未知；portfolio 或 snapshot 为空才表示未取得持仓背景。',
    portfolio: facts.portfolio ?? null,
  });
}

export function dailyFactsText(f: DailyFacts): string {
  const a = f.account;
  const lines = [
    '美股交易日报｜' + f.date,
    (a.flowMismatch ? '账户净值变动：' : '昨日盈亏（净值变动口径）：') + number(a.navChange) + ' ' + a.currency,
    '账户日收益率：' + (a.returnPct === null ? '暂缺' : signed(a.returnPct, 4) + '（' + a.measure + '）'),
    '净值：' + number(a.startNav) + ' → ' + number(a.endNav) + ' ' + a.currency + '，比较日期 ' + a.previousDate + ' → ' + a.date,
  ];
  if (a.flowMismatch) lines.push('净值差与日收益率不一致，可能包含资金进出或其他调整，不能直接把净值增加当成交易盈利。');
  lines.push('', '大盘价格表现（较前收）：');
  for (const row of f.benchmarks) lines.push(row.label + ' ' + row.symbol + '：' + (row.dayChangePct === null ? '前收暂缺' : signed(row.dayChangePct)));
  lines.push('', '当前持仓股票前五的该日价格表现（较前收）：');
  for (const row of f.holdings) lines.push(row.symbol + '：' + (row.dayChangePct === null ? '前收暂缺' : signed(row.dayChangePct)));
  for (const row of [...f.benchmarks, ...f.holdings]) if (row.corporateActions.length) lines.push(row.symbol + (row.source === 'thinkorswim' ? ' 当日有公司行动；价格采用拆股复权口径，未作分红复权。' : ' 当日有公司行动，价格涨跌包含其影响。'));
  const marketRows = [...f.benchmarks, ...f.holdings];
  const preferred = [...new Set(marketRows.filter(row => row.source === 'thinkorswim').map(row => row.symbol))];
  const fallback = [...new Set(marketRows.filter(row => row.source === 'ibkr').map(row => row.symbol))];
  if (preferred.length) lines.push('行情来源：嘉信 ' + preferred.join('、') + '（已核验复权口径）');
  if (fallback.length) lines.push('行情来源：IB ' + fallback.join('、') + '（嘉信缺失、过期或口径尚未核验时回退）');
  if (f.indicators) {
    const { fearGreed, pe, forwardPe, warnings } = f.indicators;
    lines.push('', '情绪与估值：');
    lines.push('CNN 恐慌与贪婪指数：' + (fearGreed
      ? fearGreed.value.toFixed(0) + '/100（' + fearGreedLabel(fearGreed.value) + '，' + fearGreed.date + '）' : '暂缺'));
    for (const [label, reading] of [['纳斯达克100 PE（TTM）', pe], ['纳斯达克100 Forward PE（未来12个月）', forwardPe]] as const) {
      lines.push(label + '：' + (reading ? reading.value.toFixed(2) + ' 倍｜近10年分位数 ' + reading.percentile10y.toFixed(1) + '%（' + reading.date + '）' : '暂缺'));
    }
    lines.push('来源：CNN（FearGreedMeter 转载）、Trendonify。分位数采用 Trendonify 公布的近10年历史口径，数值越高表示估值相对越高。');
    if (warnings.length) lines.push('补充数据说明：' + warnings.join('；'));
  }
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
  constructor(private readonly directory: string, private readonly model: AccountModel, private readonly load: () => Promise<DailyFacts>,
    private readonly prepare: (facts: DailyFacts) => DailyFacts = facts => facts,
    private readonly indicators?: (date: string) => Promise<DailyIndicators>) {}
  async generate(preferences = '', expectedDate?: string): Promise<string> {
    const loaded = await this.load();
    if (expectedDate && loaded.date !== expectedDate) throw new Error('目标交易日的日报数据尚未齐全');
    const facts: DailyFacts = { ...this.prepare(loaded) };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(facts.date)) throw new Error('日报日期无效');
    const dir = path.join(this.directory, 'daily-reports');
    if (this.indicators) {
      try { facts.indicators = await this.indicators(facts.date); }
      catch { facts.indicators = { fearGreed: null, pe: null, forwardPe: null, warnings: ['情绪与估值数据暂不可用'] }; }
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, facts.date + '.json');
    const fingerprint = createHash('sha256').update(JSON.stringify({ version: REPORT_VERSION, ...facts, generatedAt: '', preferences })).digest('hex');
    if (fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.fingerprint === fingerprint && typeof saved.text === 'string') return saved.text;
      } catch { /* Regenerate an incomplete local report. */ }
    }
    const base = dailyFactsText(facts);
    let analysis = basicMarketSummary(facts);
    if (this.model.configured) {
      const result = await this.model.answer(REVIEW_PROMPT, portfolioState(facts), preferences, analysisContext(facts, base));
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
