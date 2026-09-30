import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PortfolioBot } from '../server/bot/service.js';
import { BotStore } from '../server/bot/store.js';
import { ResearchJobs } from '../server/research/jobs.js';
import type { ResearchInput, ResearchResult, ResearchRunner } from '../server/research/runner.js';
import type { DashboardState } from '../shared/types.js';
import { normalizeSnapshot } from '../server/normalize.js';

let sequence = 0;
const message = (content: string, overrides = {}) => ({ sender_id: 'ou_owner', sender_type: 'user', chat_type: 'p2p', message_type: 'text', message_id: 'om_' + ++sequence, create_time: String(Date.now()), content, ...overrides });
const result: ResearchResult = { summary: '研究完成：中文报告。', report: '完整研究报告。', rating: 'Hold', model: 'same-model', revision: '8b22d43d01d9ddda5d686d093d5385884622f3de', analysts: ['market', 'social', 'news', 'fundamentals'] };

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-bot-'));
  const now = new Date().toISOString();
  const snapshot = normalizeSnapshot({ positions: [] }, { currency: 'USD', net_liquidation: 1000, total_cash_value: 900 }, { balances: [] }, { positions: now, summary: now, balances: now });
  const state = { snapshot, quotes: {}, history: [], status: { connected: true, stale: false } } as DashboardState;
  const config = { enabled: true, profile: 'test', cliPath: 'unused', ownerOpenId: 'ou_owner', botOpenId: 'ou_bot', dataDir: directory, timeZone: 'Asia/Shanghai', publicUrl: 'http://127.0.0.1:8048' };
  const store = new BotStore(directory, 'test', 'ou_owner');
  const sent: { recipient: string; text: string; key: string }[] = [];
  const inputs: ResearchInput[] = [];
  const completion = Promise.withResolvers<ResearchResult>();
  const notified = Promise.withResolvers<void>();
  const transport = { send: async (recipient: string, text: string, key: string) => { sent.push({ recipient, text, key }); if (key.startsWith('research-result:')) notified.resolve(); } };
  const runner: ResearchRunner = { modelName: 'same-model', unavailable: () => null, run: async (input, signal) => {
    inputs.push(input);
    signal.addEventListener('abort', () => completion.reject(new Error('已取消')), { once: true });
    return completion.promise;
  } };
  const jobs = new ResearchJobs(directory, runner);
  let normalCalls = 0;
  const model = { name: 'same-model', configured: true, answer: async () => { normalCalls++; return '普通问答'; } };
  const bot = new PortfolioBot(config, store, { view: () => state, refresh: async () => {} }, transport, model, undefined, jobs);
  return { bot, store, jobs, sent, inputs, completion, notified, transport, normalCalls: () => normalCalls,
    clean: async () => { completion.resolve(result); await bot.stop(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('research discovery and idle management commands never invoke a model', async () => {
  const context = fixture();
  try {
    for (const command of ['/research', '/research help']) {
      await context.bot.receive(message(command));
      assert.match(context.sent.at(-1)!.text, /\/research AAPL/);
      assert.match(context.sent.at(-1)!.text, /绝不下单/);
      assert.equal(context.sent.at(-1)!.recipient, 'ou_owner');
    }
    for (const command of ['/research status', '/research report', '/research cancel']) {
      const replies = context.sent.length;
      await context.bot.receive(message(command));
      assert.equal(context.sent.length, replies + 1);
    }
    await context.bot.receive(message('/research help', { sender_id: 'ou_guest' }));
    assert.equal(context.sent.length, 5);
    assert.equal(context.inputs.length, 0);
    assert.equal(context.normalCalls(), 0);
    assert.equal(context.jobs.status().running, false);
  } finally { await context.clean(); }
});

test('explicit research runs in the background, deduplicates messages and leaves normal portfolio queries responsive', async () => {
  const context = fixture();
  try {
    const event = message('/research AAPL');
    await context.bot.receive(event);
    assert.equal(context.inputs.length, 1);
    assert.equal(context.normalCalls(), 0);
    assert.match(context.sent[0].text, /same-model/);
    await context.bot.receive(event);
    assert.equal(context.inputs.length, 1);
    await context.bot.receive(message('摘要'));
    assert.match(context.sent.at(-1)!.text, /1,000 USD/);
    await context.bot.receive(message('/research status'));
    assert.match(context.sent.at(-1)!.text, /研究中/);
    context.completion.resolve(result);
    await context.notified.promise;
    await new Promise(resolve => setImmediate(resolve));
    await context.bot.receive(message('/research report'));
    assert.equal(context.sent.at(-1)!.text, result.report);
    assert.equal(context.sent.filter(item => item.key.startsWith('research-result:')).length, 1);
  } finally { await context.clean(); }
});

test('research preserves owner and group-at permissions and rechecks group access before returning results', async () => {
  const context = fixture();
  const group = { chat_type: 'group', chat_id: 'oc_test', sender_id: 'ou_guest', mentions: [{ id: 'ou_bot', name: '持仓助手', key: '@_user_1' }] };
  try {
    await context.bot.receive(message('/research AAPL', { sender_id: 'ou_guest' }));
    await context.bot.receive(message('@_user_1 /research AAPL', group));
    assert.equal(context.inputs.length, 0);
    context.bot.updateGroups([{ chatId: 'oc_test', name: 'Test', access: 'members', members: [] }]);
    await context.bot.receive(message('/research AAPL', { ...group, mentions: [] }));
    assert.equal(context.inputs.length, 0);
    await context.bot.receive(message('@_user_1 /research AAPL', group));
    assert.equal(context.inputs.length, 1);
    assert.equal(context.sent.at(-1)!.recipient, 'oc_test');
    await context.bot.receive(message('/research status'));
    assert.match(context.sent.at(-1)!.text, /当前聊天尚无研究任务/);
    context.bot.updateGroups([{ chatId: 'oc_test', name: 'Test', access: 'disabled', members: [] }]);
    context.completion.resolve(result);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.sent.filter(item => item.key.startsWith('research-result:')).length, 0);
  } finally { await context.clean(); }
});

test('a failed acknowledgement never starts a paid research run', async () => {
  const context = fixture();
  try {
    context.transport.send = async () => { throw new Error('Failed acknowledgement'); };
    await context.bot.receive(message('/research AAPL'));
    assert.equal(context.inputs.length, 0);
    assert.equal(context.jobs.status().running, false);
  } finally { await context.clean(); }
});

test('ordinary questions and attempted execution commands cannot silently launch TradingAgents', async () => {
  const context = fixture();
  try {
    await context.bot.receive(message('深度研究 AAPL'));
    assert.equal(context.normalCalls(), 1);
    assert.equal(context.inputs.length, 0);
    await context.bot.receive(message('/research AAPL 买入100股'));
    assert.equal(context.inputs.length, 0);
    assert.match(context.sent.at(-1)!.text, /固定命令/);
    assert.match(context.sent.at(-1)!.text, /绝不下单/);
  } finally { await context.clean(); }
});
