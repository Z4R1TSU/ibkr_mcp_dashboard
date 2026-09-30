import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readModelConfig } from '../server/bot/config.js';
import { modelRequest } from '../server/bot/model-protocol.js';
import { researchPayload, startModelBridge } from '../server/research/bridge.js';
import { parseResearchCommand, ResearchJobs } from '../server/research/jobs.js';
import { PythonResearchRunner, researchAccount, researchConfig, researchDate, workerEnvironment, type ResearchResult, type ResearchRunner } from '../server/research/runner.js';
import { normalizeSnapshot } from '../server/normalize.js';
import type { DashboardState } from '../shared/types.js';

const fixtureResult: ResearchResult = { summary: '中文研究总结，仅供研究。', report: '完整报告，仅研究未下单。', rating: 'Hold', model: 'same-model', revision: '8b22d43d01d9ddda5d686d093d5385884622f3de', analysts: ['market', 'social', 'news', 'fundamentals'] };
const input = { ticker: 'AAPL', date: '2026-09-30', account: null };

test('research is an explicit command, never a magic phrase or an execution instruction', () => {
  assert.deepEqual(parseResearchCommand('/research aapl'), { kind: 'run', ticker: 'AAPL' });
  assert.deepEqual(parseResearchCommand(' /RESEARCH $TSLA '), { kind: 'run', ticker: 'TSLA' });
  assert.deepEqual(parseResearchCommand('/research 0700.HK'), { kind: 'run', ticker: '0700.HK' });
  assert.deepEqual(parseResearchCommand('/research'), { kind: 'help' });
  assert.deepEqual(parseResearchCommand('/research cancel'), { kind: 'cancel' });
  for (const text of ['深度研究 AAPL', '帮我买 AAPL', '研究一下我的持仓', '/researcher AAPL']) assert.equal(parseResearchCommand(text), null);
  for (const text of ['/research AAPL 买入100股', '/research ../../.env', '/research AAPL;curl', '/research AAPL MSFT', '/research .env']) assert.deepEqual(parseResearchCommand(text), { kind: 'invalid' });
});

test('AIDP preserves tool messages and structured output without changing its credential protocol', () => {
  const config = readModelConfig({ MODEL_PROVIDER: 'aidp', MODEL_BASE_URL: 'https://aidp.bytedance.net/api/modelhub/online/v2/crawl', MODEL_API_KEY: 'secret-value', MODEL_NAME: 'same-model' });
  const call = { id: 'call_1', type: 'function', function: { name: 'get_news', arguments: '{}' } };
  const request = modelRequest(config, [{ role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', content: 'fictional', tool_call_id: 'call_1' }], { tool_choice: 'none', response_format: { type: 'json_object' } });
  const body = JSON.parse(String(request.init.body));
  assert.equal(body.model, 'same-model');
  assert.deepEqual(body.messages[0], { role: 'assistant', tool_calls: [call], content: [] });
  assert.deepEqual(body.messages[1], { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'fictional' }] });
  assert.equal(body.tool_choice, 'none');
  assert.doesNotMatch(String(request.init.body), /secret-value/);
});

test('research gateway accepts only the configured model and an explicit read-only tool set', () => {
  const payload = { model: 'same-model', messages: [{ role: 'user', content: '研究测试' }], tools: [{ type: 'function', function: { name: 'get_news', parameters: {} } }] };
  const accepted = researchPayload({ ...payload, base_url: 'https://attacker.example', api_key: 'injected' }, 'same-model');
  assert.match(accepted.messages[0].content!, /绝不执行/);
  assert.equal(accepted.options.tools?.length, 1);
  assert.doesNotMatch(JSON.stringify(accepted), /attacker|injected/);
  assert.throws(() => researchPayload({ ...payload, model: 'different-model' }, 'same-model'));
  assert.throws(() => researchPayload({ ...payload, stream: true }, 'same-model'));
  for (const name of ['place_order', 'cancel_order', 'transfer', 'execute_shell', 'ibkr_place_order']) {
    assert.throws(() => researchPayload({ ...payload, tools: [{ type: 'function', function: { name } }] }, 'same-model'));
    assert.throws(() => researchPayload({ ...payload, messages: [{ role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'call', function: { name, arguments: '{}' } }] }] }, 'same-model'));
  }
});

test('worker inherits neither broker credentials, Feishu credentials, model keys nor tracing configuration', () => {
  const environment = workerEnvironment('/private/job', 'ephemeral-token', { PATH: '/usr/bin', MODEL_API_KEY: 'real-key', IB_TOKEN: 'ib-secret', FEISHU_APP_SECRET: 'lark-secret', OPENAI_API_KEY: 'other-key', LANGSMITH_API_KEY: 'trace-secret', DATA_DIR: '/private/account' });
  assert.equal(environment.HOME, '/private/job');
  assert.equal(environment.PYTHON_DOTENV_DISABLED, '1');
  assert.equal(environment.OPENAI_COMPATIBLE_API_KEY, 'ephemeral-token');
  assert.doesNotMatch(JSON.stringify(environment), /real-key|ib-secret|lark-secret|other-key|trace-secret|private\/account/);
});

test('account context preserves unknowns and currency and never exports position IDs', () => {
  const time = '2026-09-30T06:00:00Z';
  const snapshot = normalizeSnapshot({ positions: [{ contract_id: 123456, contract_description: 'AAPL', asset_class: 'STK', position: 2, currency: 'USD' }] }, { currency: 'USD', net_liquidation: 1000, total_cash_value: 900 }, { balances: [] }, { positions: time, summary: time, balances: time });
  const state = { snapshot, status: { connected: false, stale: false } } as DashboardState;
  const facts = researchAccount(state) as any;
  assert.equal(facts.stale, true);
  assert.equal(facts.account.currency, 'USD');
  assert.equal(facts.account.availableFunds, null);
  assert.equal(facts.positions[0].id, undefined);
  assert.doesNotMatch(JSON.stringify(facts), /123456/);
  assert.equal(researchAccount({ snapshot: null } as DashboardState), null);
  assert.equal(researchDate(new Date('2026-10-01T01:00:00Z')), '2026-09-30');
  assert.throws(() => researchConfig({ TRADINGAGENTS_MAX_CALLS: '0' }));
});

test('research bridge authenticates, fixes the upstream model, and enforces a per-job call budget', async () => {
  let calls = 0;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), 'https://model.example/v1/chat/completions');
    assert.equal(JSON.parse(String(init?.body)).model, 'same-model');
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '研究结果' }, finish_reason: 'stop' }] }), { status: 200 });
  }) as typeof fetch;
  const config = readModelConfig({ MODEL_BASE_URL: 'https://model.example/v1', MODEL_NAME: 'same-model', MODEL_API_KEY: 'real-model-key' });
  const bridge = await startModelBridge(config, { maxCalls: 1, signal: new AbortController().signal }, fakeFetch);
  const body = JSON.stringify({ model: 'same-model', messages: [{ role: 'user', content: '研究' }] });
  try {
    assert.equal((await fetch(bridge.url + '/chat/completions', { method: 'POST', body })).status, 403);
    const headers = { Authorization: 'Bearer ' + bridge.token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(bridge.url + '/chat/completions', { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body })).status, 403);
    const response = await fetch(bridge.url + '/chat/completions', { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /real-model-key/);
    assert.equal((await fetch(bridge.url + '/chat/completions', { method: 'POST', headers, body })).status, 429);
    assert.equal(calls, 1);
  } finally { await bridge.close(); }
});

test('installed native Python client reaches the authenticated local bridge', { skip: !fs.existsSync('.venv-tradingagents/bin/python') }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-python-'));
  const controller = new AbortController();
  const fakeFetch = (async () => new Response(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'gpt-5.6-sol', choices: [{ index: 0, message: { role: 'assistant', content: '本机测试' }, finish_reason: 'stop' }] }))) as typeof fetch;
  const bridge = await startModelBridge(readModelConfig({ MODEL_BASE_URL: 'https://unused.example/v1', MODEL_NAME: 'gpt-5.6-sol', MODEL_API_KEY: 'not-sent' }), { maxCalls: 1, signal: controller.signal }, fakeFetch);
  try {
    fs.writeFileSync(path.join(directory, '.env'), '');
    fs.writeFileSync(path.join(directory, '.env.enterprise'), '');
    const python = path.resolve('.venv-tradingagents/bin/python');
    const script = [
      'import sys, runpy, json',
      'adapter = runpy.run_path(sys.argv[2])',
      'adapter["configure_bridge_client"]()',
      'from tradingagents.llm_clients import create_llm_client',
      'model = create_llm_client("openai_compatible", "gpt-5.6-sol", base_url=sys.argv[1], max_retries=0).get_llm()',
      'print(model.invoke("协议联调").content)',
      'from tradingagents.default_config import build_default_config',
      'from tradingagents.graph.trading_graph import TradingAgentsGraph',
      'config = build_default_config()',
      'config.update(llm_provider="openai_compatible", deep_think_llm="gpt-5.6-sol", quick_think_llm="gpt-5.6-sol", backend_url=sys.argv[1])',
      'graph = TradingAgentsGraph(config=config)',
      'graph.settle_pending = lambda *_: None',
      'graph.resolve_instrument_context = lambda *_: "Fictional test ticker"',
      'graph.memory_log.get_past_context = lambda *args, **kwargs: ""',
      'facts = {"fetchedAt":"2026-09-30T06:00:00Z","stale":True,"positions":[{"symbol":"AAPL","kind":"option","quantity":None,"currency":"USD","option":{"right":"P","strike":100}}]}',
      'state = graph.create_run_state("AAPL", "2026-09-30", portfolio=adapter["AccountContext"](facts))',
      'assert json.dumps(facts, ensure_ascii=False) in state["portfolio_context"]',
      'assert "null 是未知而不是零" in state["portfolio_context"]',
      'print("portfolio-context-verified")',
    ].join('\n');
    const result = await promisify(execFile)(python, ['-I', '-c', script, bridge.url, path.resolve('integrations/tradingagents/worker.py')], { cwd: directory, env: workerEnvironment(directory, bridge.token), timeout: 30000 });
    assert.match(result.stdout, /本机测试/);
    assert.match(result.stdout, /portfolio-context-verified/);
  } finally { controller.abort(); await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('research serializes upstream calls and honors bounded, cancellable rate-limit retries', async () => {
  let inFlight = 0;
  let maximum = 0;
  let attempts = 0;
  let waits = 0;
  const fakeFetch = (async () => {
    attempts++; inFlight++; maximum = Math.max(maximum, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
    if (attempts === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }] }));
  }) as typeof fetch;
  const config = readModelConfig({ MODEL_BASE_URL: 'https://unused.example/v1', MODEL_NAME: 'same-model', MODEL_API_KEY: 'key' });
  const bridge = await startModelBridge(config, { maxCalls: 3, signal: new AbortController().signal, onThrottle: () => { waits++; } }, fakeFetch);
  try {
    const init = { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token }, body: JSON.stringify({ model: 'same-model', messages: [{ role: 'user', content: '研究' }] }) };
    const responses = await Promise.all([fetch(bridge.url + '/chat/completions', init), fetch(bridge.url + '/chat/completions', init)]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.equal(maximum, 1);
    assert.equal(attempts, 3);
    assert.equal(waits, 1);
  } finally { await bridge.close(); }
});

test('cancelling a throttled research request stops waiting without another paid attempt', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const fakeFetch = (async () => { attempts++; return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }); }) as typeof fetch;
  const bridge = await startModelBridge(readModelConfig({ MODEL_BASE_URL: 'https://unused.example/v1', MODEL_NAME: 'same-model', MODEL_API_KEY: 'key' }), {
    maxCalls: 10, signal: controller.signal, onThrottle: () => controller.abort(),
  }, fakeFetch);
  try {
    const response = await fetch(bridge.url + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token }, body: JSON.stringify({ model: 'same-model', messages: [{ role: 'user', content: '研究' }] }) });
    assert.equal(response.status, 502);
    assert.equal(attempts, 1);
    assert.match(await response.text(), /Research stopped/);
  } finally { await bridge.close(); }
});

test('cancellation and deadlines terminate the actual Python worker without model calls', { skip: !fs.existsSync('.venv-tradingagents/bin/python') }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-worker-stop-'));
  const worker = path.join(directory, 'worker.py');
  fs.writeFileSync(worker, 'import sys, json, time, os\njson.load(sys.stdin)\nassert os.environ.get("MODEL_API_KEY") is None\nassert os.environ.get("PYTHON_DOTENV_DISABLED") == "1"\nprint(json.dumps({"event":"progress","stage":"started"}), flush=True)\ntime.sleep(60)\n');
  const model = readModelConfig({ MODEL_BASE_URL: 'https://unused.example/v1', MODEL_NAME: 'same-model', MODEL_API_KEY: 'never-inherited' });
  try {
    const controller = new AbortController();
    const config = { ...researchConfig({}), worker, timeoutMs: 10000 };
    const runner = new PythonResearchRunner(config, model);
    await assert.rejects(runner.run({ ...input, directory: path.join(directory, 'cancel') }, controller.signal, () => controller.abort()), /已取消/);
    const deadlineRunner = new PythonResearchRunner({ ...config, timeoutMs: 100 }, model);
    await assert.rejects(deadlineRunner.run({ ...input, directory: path.join(directory, 'deadline') }, new AbortController().signal, () => {}), /超过运行时限/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('native worker output preserves Chinese text across pipe chunks', { skip: !fs.existsSync('.venv-tradingagents/bin/python') }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-worker-unicode-'));
  const worker = path.join(directory, 'worker.py');
  const expected = '研究报告中文边界测试'.repeat(10000);
  fs.writeFileSync(worker, 'import sys, json\njson.load(sys.stdin)\nprint(json.dumps({"event":"result","summary":"研究报告中文边界测试"*10000,"report":"完整报告","rating":"Hold","model":"same-model","revision":"8b22d43d01d9ddda5d686d093d5385884622f3de","analysts":["market","social","news","fundamentals"]}, ensure_ascii=False), flush=True)\n');
  const runner = new PythonResearchRunner({ ...researchConfig({}), worker }, readModelConfig({ MODEL_BASE_URL: 'https://unused.example/v1', MODEL_NAME: 'same-model', MODEL_API_KEY: 'never-sent' }));
  try {
    const received = await runner.run({ ...input, directory: path.join(directory, 'job') }, new AbortController().signal, () => {});
    assert.equal(received.summary, expected);
    assert.equal(fs.readFileSync(path.join(directory, 'job/.env'), 'utf8'), '');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('research jobs isolate chats, reserve before acknowledgement, persist results and survive restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-jobs-'));
  let calls = 0;
  const runner: ResearchRunner = { modelName: 'same-model', unavailable: () => null, run: async () => { calls++; return fixtureResult; } };
  const jobs = new ResearchJobs(directory, runner);
  try {
    const task = jobs.prepare('dm:owner', 'owner', input);
    assert.equal(calls, 0);
    assert.throws(() => jobs.prepare('group:other', 'other', input), /已有研究任务/);
    assert.match(jobs.describe('group:other'), /当前聊天尚无研究任务/);
    assert.doesNotMatch(jobs.describe('group:other'), /任务：|模型调用：/);
    const delivered = Promise.withResolvers<void>();
    task.start(async () => delivered.resolve(), () => true);
    await delivered.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(jobs.report('dm:owner'), fixtureResult.report);
    assert.doesNotMatch(jobs.report('group:other'), /完整报告/);
    assert.equal(new ResearchJobs(directory, runner).report('dm:owner'), fixtureResult.report);
    const queued = jobs.prepare('dm:owner', 'owner', input);
    assert.match(new ResearchJobs(directory, runner).describe('dm:owner'), /重启中断/);
    queued.discard();
    assert.equal(calls, 1);
  } finally { await jobs.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('cancellation is scoped and authorized, and revoked access suppresses late delivery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-cancel-'));
  const result = Promise.withResolvers<ResearchResult>();
  let receivedSignal: AbortSignal | undefined;
  const runner: ResearchRunner = { modelName: 'same-model', unavailable: () => null, run: async (_input, signal) => { receivedSignal = signal; return result.promise; } };
  const jobs = new ResearchJobs(directory, runner);
  let deliveries = 0;
  try {
    const task = jobs.prepare('group:first', 'requester', input);
    task.start(async () => { deliveries++; }, () => false);
    assert.match(jobs.cancel('group:other', 'requester', 'owner'), /没有正在运行/);
    assert.match(jobs.cancel('group:first', 'stranger', 'owner'), /仅研究发起人/);
    assert.equal(receivedSignal?.aborted, false);
    assert.match(jobs.cancel('group:first', 'owner', 'owner'), /已请求停止/);
    assert.equal(receivedSignal?.aborted, true);
    result.resolve(fixtureResult);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deliveries, 0);
    assert.match(jobs.describe('group:first'), /已取消/);
    assert.doesNotMatch(jobs.report('group:first'), /完整报告，仅研究/);
  } finally { result.resolve(fixtureResult); await jobs.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});
