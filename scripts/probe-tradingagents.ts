import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readModelConfig } from '../server/bot/config.js';
import { PythonResearchRunner, researchConfig, researchDate } from '../server/research/runner.js';

const ticker = (process.argv[2] || 'AAPL').toUpperCase();
if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) || ticker.includes('..')) throw new Error('Provide one valid public ticker');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-tradingagents-smoke-'));
const model = readModelConfig(process.env);
const runner = new PythonResearchRunner(researchConfig(process.env), model);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
console.log(JSON.stringify({ ticker, model: model.name, directory, accountDataSent: false, feishuMessagesSent: false }));
try {
  const result = await runner.run({ ticker, date: researchDate(), account: null, directory }, controller.signal,
    (stage, calls) => console.log(JSON.stringify({ stage, calls })));
  const conclusion = result.summary.split('## 综合研究结论\n\n').at(-1) ?? '';
  const critical = new Set(['quote', 'market', 'financials', 'disclosures', 'price_validation', 'financial_validation']);
  const missingCritical = (result.quality?.missing ?? []).filter(name => critical.has(name));
  const valid = !missingCritical.length && !['Not rated', 'REVIEW'].includes(result.rating)
    && result.analysts.join(',') === 'market,social,news,fundamentals' && (conclusion.match(/[\u4e00-\u9fff]/g)?.length ?? 0) > 10
    && result.report.includes('技术面研究') && result.report.includes('基本面研究') && result.report.includes('市场情绪研究');
  fs.writeFileSync(path.join(directory, 'smoke-result.json'), JSON.stringify({ ...result, valid }), { mode: 0o600 });
  console.log(JSON.stringify({ valid, allSourcesAvailable: result.quality?.status === 'complete', missingCritical,
    quality: result.quality, model: result.model, revision: result.revision, report: path.join(directory, 'report.md'), reportLength: result.report.length }));
  if (!valid) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Research failed', directory }));
  process.exitCode = 1;
}
