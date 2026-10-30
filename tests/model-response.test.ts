import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretModelResponse } from '../server/bot/model-response.js';
import { CompatibleModel } from '../server/bot/model.js';
import { readModelConfig } from '../server/bot/config.js';
import type { DashboardState } from '../shared/types.js';

test('reasoning-only length exhaustion is not treated as an incompatible format', () => {
  const result = interpretModelResponse({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'PRIVATE_REASONING' } }],
    usage: { completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 500 } } });
  assert.equal(result.error, 'length');
  assert.equal(result.reasoningTokens, 500);
  assert.equal(result.text, '');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REASONING/);
});
test('normal text and text blocks are handled without exposing reasoning', () => {
  assert.equal(interpretModelResponse({ choices: [{ message: { content: ' answer ', reasoning_content: 'hidden' } }] }).text, 'answer');
  assert.equal(interpretModelResponse({ choices: [{ message: { content: [{ type: 'text', text: 'answer' }] } }] }).text, 'answer');
  assert.equal(interpretModelResponse({}).error, 'format');
  assert.equal(readModelConfig({}).maxTokens, 32768);
});
test('an empty model response returns verified FX facts instead of the old compatibility error', async () => {
  const config = readModelConfig({ MODEL_BASE_URL: 'https://model.example/v1', MODEL_NAME: 'test', MODEL_API_KEY: 'TEST' });
  const fetcher: typeof fetch = async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'PRIVATE_REASONING' } }],
    usage: { completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 500 } } });
  const model = new CompatibleModel(config, fetcher);
  const state = { snapshot: null, status: { connected: true, stale: false } } as DashboardState;
  const answer = await model.answer('换汇亏多少', state, '', '平均成本 6.8521，纯汇率变化率 -2.00%。');
  assert.match(answer, /6.8521/);
  assert.match(answer, /-2.00%/);
  assert.match(answer, /额度/);
  assert.doesNotMatch(answer, /PRIVATE_REASONING|检查接口兼容性/);
  assert.equal(model.diagnostics?.finishReason, 'length');
});

test('transient connection failure retries with the full conversation and redacted diagnostics', async () => {
  const config = readModelConfig({ MODEL_BASE_URL: 'https://model.example/v1', MODEL_NAME: 'test', MODEL_API_KEY: 'DO_NOT_LOG_KEY' });
  let calls = 0;
  const bodies: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    bodies.push(String(init?.body));
    if (calls === 1) throw Object.assign(new TypeError('DO_NOT_LOG_KEY'), { cause: { code: 'ECONNRESET' } });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'recovered' } }], usage: { prompt_tokens: 123, completion_tokens: 10 } });
  };
  const model = new CompatibleModel(config, fetcher);
  const state = { snapshot: null, status: { connected: true, stale: false } } as DashboardState;
  const answer = await model.answer('follow-up', state, '', 'fictional facts', [{ role: 'user', content: 'previous question' }, { role: 'assistant', content: 'previous answer' }]);
  assert.equal(answer, 'recovered');
  assert.equal(calls, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.match(bodies[1], /previous answer/);
  assert.equal(model.diagnostics?.attempts, 2);
  assert.equal(model.diagnostics?.promptTokens, 123);
  assert.doesNotMatch(JSON.stringify(model.diagnostics), /DO_NOT_LOG_KEY/);
});

test('overall deadline is reported separately and is not retried', async () => {
  let calls = 0;
  const config = readModelConfig({ MODEL_BASE_URL: 'https://model.example/v1', MODEL_NAME: 'test', MODEL_API_KEY: 'secret', MODEL_TIMEOUT_SECONDS: '900' });
  const model = new CompatibleModel(config, async () => { calls++; throw new DOMException('expired', 'TimeoutError'); });
  const state = { snapshot: null, status: { connected: true, stale: false } } as DashboardState;
  const answer = await model.answer('question', state, '', 'verified fact');
  assert.match(answer, /900 秒/);
  assert.equal(calls, 1);
  assert.equal(model.diagnostics?.error, 'timeout');
});
