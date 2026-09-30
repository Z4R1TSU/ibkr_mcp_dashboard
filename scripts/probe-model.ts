import 'dotenv/config';
import { readModelConfig } from '../server/bot/config.js';
import { modelRequest } from '../server/bot/model-protocol.js';
import { CompatibleModel } from '../server/bot/model.js';
import { normalizeSnapshot } from '../server/normalize.js';
import type { DashboardState } from '../shared/types.js';

const config = readModelConfig(process.env);
if (!config.baseUrl || !config.apiKey || !config.name) throw new Error('Model configuration is incomplete');
if (process.argv.includes('--memory-fixture')) {
  const state = { snapshot: null, status: { connected: true, stale: false } } as DashboardState;
  const answer = await new CompatibleModel(config).answer('我刚才设置的测试口令是什么？只返回口令。', state, '', '这是虚构的多轮记忆测试，没有账户数据。', [
    { role: 'user', content: '测试口令是青山42。' },
    { role: 'assistant', content: '记住了这个测试口令。' },
  ]);
  const valid = answer.includes('青山42');
  console.log(JSON.stringify({ test: 'memory', maxTokens: config.maxTokens, valid, answer: answer.replaceAll(config.apiKey, '[redacted]') }));
  process.exit(valid ? 0 : 1);
}
if (process.argv.includes('--portfolio-fixture')) {
  const time = new Date().toISOString();
  const snapshot = normalizeSnapshot({ positions: [] },
    { currency: 'USD', net_liquidation: 1000, total_cash_value: 900 }, { balances: [] },
    { positions: time, summary: time, balances: time });
  const state = { snapshot, quotes: {}, history: [], status: { connected: true, stale: false } } as DashboardState;
  const answer = await new CompatibleModel(config).answer('这是虚构的联调账户。只回答净值与现金余额，保留金额和币种。', state, '');
  const valid = /1,?000/.test(answer) && /900/.test(answer);
  console.log(JSON.stringify({ test: 'fictional-portfolio', model: config.name, valid, answer: answer.replaceAll(config.apiKey, '[redacted]') }, null, 2));
  process.exit(valid ? 0 : 1);
}
const request = modelRequest(config, [{ role: 'user', content: 'What is the result of 1+1? Reply with the number only.' }]);
try {
  const response = await fetch(request.url, request.init);
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  function describe(value: unknown, depth = 0): unknown {
    if (depth > 5 || value === null) return value === null ? 'null' : typeof value;
    if (Array.isArray(value)) return value.slice(0, 1).map(item => describe(item, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, describe(item, depth + 1)]));
    return typeof value;
  }
  const answer = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  console.log(JSON.stringify({ provider: config.provider, model: config.name, http: response.status, shape: describe(body), answer: typeof answer === 'string' ? answer.replaceAll(config.apiKey, '[redacted]').slice(0, 500) : null }, null, 2));
  process.exitCode = response.ok ? 0 : 1;
} catch (error) {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  console.error(JSON.stringify({ error: 'Model probe failed', code: code ?? 'request_failed' }));
  process.exitCode = 1;
}
