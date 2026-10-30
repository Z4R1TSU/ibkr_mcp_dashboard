import test from 'node:test';
import { dailyFixture } from './daily-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DashboardState } from '../shared/types.js';
import { normalizeSnapshot } from '../server/normalize.js';
import { PortfolioBot } from '../server/bot/service.js';
import { BotStore } from '../server/bot/store.js';
import { CompatibleModel } from '../server/bot/model.js';
import { readBotConfig, readModelConfig } from '../server/bot/config.js';

function fixture(owner = 'ou_owner') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-bot-test-'));
  const now = new Date().toISOString();
  const snapshot = normalizeSnapshot({ positions: [] }, { currency: 'USD', net_liquidation: 1000, total_cash_value: 900 }, { balances: [] },
    { positions: now, summary: now, balances: now });
  const state = { snapshot, quotes: {}, history: [], status: { connected: true, stale: false } } as DashboardState;
  const sent: { to: string; text: string; key: string }[] = [];
  const acknowledged: string[] = [];
  const cards: { to: string; card: object }[] = [];
  const config = { enabled: true, profile: 'test', cliPath: 'unused', ownerOpenId: owner, botOpenId: 'ou_bot', dataDir: directory, timeZone: 'Asia/Shanghai', publicUrl: 'http://127.0.0.1:8048' };
  const store = new BotStore(directory, 'test', owner);
  const model = new CompatibleModel(readModelConfig({}));
  let refreshes = 0;
  const source = { view: () => state, refresh: async () => { refreshes++; }, dailyFacts: async () => dailyFixture() };
  const transport = { send: async (to: string, text: string, key: string) => { sent.push({ to, text, key }); },
    acknowledge: async (id: string) => { acknowledged.push(id); },
    sendCard: async (to: string, card: object) => { cards.push({ to, card }); } };
  const bot = new PortfolioBot(config, store, source, transport, model);
  return { directory, config, state, source, sent, acknowledged, cards, transport, store, bot, refreshes: () => refreshes, clean: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

let sequence = 0;

test('slash commands use account handlers, rate limits and deterministic usage replies', async () => {
  const f = fixture();
  let modelCalls = 0;
  let refreshes = 0;
  const model = { configured: true, name: 'unused', answer: async () => { modelCalls++; return 'model'; } };
  const bot = new PortfolioBot(f.config, f.store, { view: () => f.state, refresh: async () => { refreshes++; }, forex: async () => '换汇测试' }, f.transport, model);
  try {
    await bot.receive(message('/summary'));
    assert.match(f.sent.at(-1)!.text, /1,000 USD/);
    await bot.receive(message('/dashboard'));
    assert.equal(f.cards.length, 1);
    await bot.receive(message('/fx'));
    assert.equal(f.sent.at(-1)!.text, '换汇测试');
    await bot.receive(message('/refresh'));
    await bot.receive(message('/refresh'));
    assert.equal(refreshes, 1);
    const invalid = message('/summary unexpected');
    await bot.receive(invalid);
    const count = f.sent.length;
    await bot.receive(invalid);
    assert.equal(f.sent.length, count);
    assert.match(f.sent.at(-1)!.text, /用法/);
    await bot.receive(message('/buy AAPL'));
    assert.match(f.sent.at(-1)!.text, /未知/);
    assert.equal(modelCalls, 0);
  } finally { await bot.stop(); f.clean(); }
});

test('slash aliases preserve owner-only settings and group mention checks', async () => {
  const f = fixture();
  try {
    await f.bot.receive({ ...message('/summary'), sender_id: 'ou_other' });
    assert.equal(f.sent.length, 0);
    f.bot.updateGroups([{ chatId: 'oc_test', name: 'Test', access: 'members', members: [] }]);
    await f.bot.receive({ ...groupMessage('/risk'), mentions: [] });
    assert.equal(f.sent.length, 0);
    await f.bot.receive(groupMessage('@_user_1 /risk'));
    assert.match(f.sent.at(-1)!.text, /账户风险/);
    await f.bot.receive(groupMessage('/alerts on'));
    assert.equal(f.store.state.alerts, false);
    assert.match(f.sent.at(-1)!.text, /私聊/);
    await f.bot.receive(groupMessage('/daily 09:30', 'ou_owner'));
    assert.equal(f.store.state.dailyTime, null);
    await f.bot.receive(message('/daily 9:30'));
    assert.equal(f.store.state.dailyTime, '09:30');
    assert.equal(f.store.state.dailyTimeZone, 'Asia/Shanghai');
    await f.bot.receive(message('/daily off'));
    assert.equal(f.store.state.dailyTime, null);
    await f.bot.receive(message('/alerts on'));
    assert.equal(f.store.state.alerts, true);
  } finally { await f.bot.stop(); f.clean(); }
});
const groupMessage = (content: string, sender = 'ou_guest') => ({ ...message(content), sender_id: sender, chat_type: 'group', chat_id: 'oc_test', mentions: [{ id: 'ou_bot', name: '持仓助手', key: '@_user_1' }] });
const message = (content: string) => ({ sender_id: 'ou_owner', sender_type: 'user', chat_type: 'p2p', message_type: 'text', message_id: 'om_' + ++sequence, create_time: String(Date.now()), content });

test('login works without IB and returns the entry only in the owner DM', async () => {
  const f = fixture();
  f.state.status.connected = false;
  f.config.publicUrl = 'http://127.0.0.1:62481';
  const unexpected = async () => { throw new Error('Login must not call the model or IB'); };
  const bot = new PortfolioBot(f.config, f.store, { view: () => f.state, refresh: unexpected, forex: unexpected },
    f.transport, { configured: true, name: 'unused', answer: unexpected });
  try {
    await bot.receive(message('/login'));
    assert.equal(f.sent.length, 1);
    assert.ok(f.sent[0].text.includes(f.config.publicUrl));
    assert.match(f.sent[0].text, /连接 IB.*只读授权/);
    assert.match(f.sent[0].text, /SSH 隧道/);
    assert.match(f.sent[0].text, /同一浏览器/);
    await bot.receive({ ...message('/login'), sender_id: 'ou_other' });
    assert.equal(f.sent.length, 1);
    bot.updateGroups([{ chatId: 'oc_test', name: 'Test', access: 'members', members: [] }]);
    for (const sender of ['ou_owner', 'ou_guest']) {
      await bot.receive(groupMessage('/login', sender));
      assert.match(f.sent.at(-1)!.text, /仅允许账户持有人在私聊/);
      assert.equal(f.sent.at(-1)!.text.includes(f.config.publicUrl), false);
    }
    f.config.publicUrl = 'https://portfolio.example';
    await bot.receive(message('连接 IB'));
    assert.ok(f.sent.at(-1)!.text.includes(f.config.publicUrl));
    assert.doesNotMatch(f.sent.at(-1)!.text, /SSH|本机地址|手机无法/);
    await bot.receive(message('/help'));
    assert.ok(f.sent.at(-1)!.text.includes('/login'));
  } finally { await bot.stop(); f.clean(); }
});

test('IB recovery hints reflect authorization loss during FX reads and disappear after recovery', async () => {
  const f = fixture();
  const model = new CompatibleModel(readModelConfig({}));
  const bot = new PortfolioBot(f.config, f.store, {
    view: () => f.state, refresh: async () => {},
    forex: async () => { f.state.status.connected = false; return '换汇读取失败'; },
  }, f.transport, model);
  try {
    await bot.receive(message('/status'));
    assert.equal(f.sent.at(-1)!.text.includes('/login'), false);
    await bot.receive(message('/fx'));
    assert.match(f.sent.at(-1)!.text, /换汇读取失败/);
    assert.ok(f.sent.at(-1)!.text.includes('/login'));
    await bot.receive(message('/status'));
    assert.match(f.sent.at(-1)!.text, /IB 授权待恢复/);
    assert.ok(f.sent.at(-1)!.text.includes('/login'));
    await bot.receive(message('/summary'));
    assert.ok(f.sent.at(-1)!.text.includes('/login'));
    f.state.status.connected = true;
    for (const command of ['/status', '/summary']) {
      await bot.receive(message(command));
      assert.equal(f.sent.at(-1)!.text.includes('/login'), false);
    }
  } finally { await bot.stop(); f.clean(); }
});

test('queued messages get receipt feedback before a slow model completes', async () => {
  const f = fixture();
  const release = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  try {
    const model = { configured: true, name: 'slow', answer: async () => { entered.resolve(); return release.promise; } };
    const bot = new PortfolioBot(f.config, f.store, { view: () => f.state, refresh: async () => {} }, f.transport, model);
    const first = message('分析一下');
    const running = bot.receive(first);
    await entered.promise;
    const next = message('摘要');
    const queued = bot.receive(next);
    await bot.receive({ ...next, sender_id: 'ou_other' });
    assert.deepEqual(f.acknowledged, [first.message_id, next.message_id]);
    assert.equal(f.sent.length, 0);
    release.resolve('**分析结果**');
    await Promise.all([running, queued]);
    assert.equal(f.sent.length, 2);
  } finally { release.resolve('done'); f.clean(); }
});

test('receipt failure does not prevent the answer; dashboard commands send cards under existing permissions', async () => {
  const f = fixture();
  try {
    f.transport.acknowledge = async () => { throw new Error('scope missing'); };
    await f.bot.receive(message('摘要'));
    assert.equal(f.sent.length, 1);
    await f.bot.receive(message('打开看板'));
    assert.equal(f.cards.length, 1);
    assert.equal(f.cards[0].to, 'ou_owner');
    await f.bot.receive(groupMessage('看板'));
    assert.equal(f.cards.length, 1);
    f.bot.updateGroups([{ chatId: 'oc_test', name: 'Test', access: 'members', members: [] }]);
    await f.bot.receive(groupMessage('看板'));
    assert.equal(f.cards[1].to, 'oc_test');
    f.transport.sendCard = async () => { throw new Error('card unavailable'); };
    await f.bot.receive(message('看板'));
    assert.match(f.sent.at(-1)!.text, /卡片暂时发送失败[\s\S]*1,000 USD/);
  } finally { f.clean(); }
});

test('duplicate messages reply once, and dedup survives restart', async () => {
  const f = fixture();
  try {
    const event = message('刷新');
    await Promise.all([f.bot.receive(event), f.bot.receive(event)]);
    await f.bot.receive(event);
    assert.equal(f.refreshes(), 1);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.acknowledged, [event.message_id]);
    assert.equal(new BotStore(f.directory, 'test').delivered('message:' + event.message_id), true);
    await f.bot.receive(message('我的风险如何？'));
    assert.match(f.sent[1].text, /MODEL_BASE_URL/);
  } finally { f.clean(); }
});

test('daily push requires subscription, survives restart, and stops after cancellation', async () => {
  const f = fixture();
  const now = new Date('2026-09-26T01:00:00Z');
  const dateKey = now.toISOString().slice(0, 10);
  try {
    await f.bot.tick(now);
    assert.equal(f.sent.length, 0);
    await f.bot.receive(message('订阅日报 09:00'));
    await f.bot.tick(now);
    await f.bot.tick(new Date(now.getTime() + 30 * 60000));
    assert.equal(f.sent.filter(s => s.key.startsWith('daily-report:')).length, 1);
    const restored = new BotStore(f.directory, 'test');
    assert.equal(restored.delivered('daily:' + dateKey, now.getTime()), true);
    await f.bot.receive(message('取消日报'));
    await f.bot.tick(new Date(now.getTime() + 86400000));
    assert.equal(f.sent.filter(s => s.key.startsWith('daily-report:')).length, 1);
  } finally { f.clean(); }
});

test('11 AM Beijing skips Sunday and Monday, then resumes with a new report on Tuesday', async () => {
  const f = fixture();
  let reportDate = '2026-10-16', loads = 0;
  f.source.dailyFacts = async () => {
    loads++;
    const facts = dailyFixture();
    return { ...facts, date: reportDate, account: { ...facts.account, date: reportDate } };
  };
  f.store.state.dailyTime = '11:00';
  try {
    await f.bot.tick(new Date('2026-10-17T03:00:00Z'));
    await f.bot.tick(new Date('2026-10-18T03:00:00Z'));
    await f.bot.tick(new Date('2026-10-19T03:00:00Z'));
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /美股交易日报｜2026-10-16/);
    assert.equal(loads, 1);
    reportDate = '2026-10-19';
    await f.bot.tick(new Date('2026-10-20T03:00:00Z'));
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1].text, /美股交易日报｜2026-10-19/);
    // Manual requests remain available on weekends.
    await f.bot.receive(message('/daily'));
    assert.equal(f.sent.length, 3);
  } finally { f.clean(); }
});

test('report-date dedup survives restart and changing the schedule across midnight', async () => {
  const f = fixture();
  f.store.state.dailyTime = '21:00';
  f.store.state.dailyTimeZone = 'UTC';
  try {
    await f.bot.tick(new Date('2026-09-25T21:00:00Z'));
    const restored = new BotStore(f.directory, 'test');
    restored.state.dailyTime = '01:00';
    const bot = new PortfolioBot(f.config, restored, f.source, f.transport, new CompatibleModel(readModelConfig({})));
    await bot.tick(new Date('2026-09-26T01:00:00Z'));
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /2026-09-25/);
  } finally { f.clean(); }
});

test('stale data and send failures retry within the hour without marking the report delivered', async () => {
  const f = fixture();
  f.store.state.dailyTime = '11:00';
  try {
    const now = new Date('2026-09-29T03:00:00Z');
    await assert.rejects(f.bot.tick(now), /目标交易日/);
    assert.equal(f.sent.length, 0);
    assert.equal(fs.existsSync(path.join(f.directory, 'daily-reports')), false);
    f.source.dailyFacts = async () => {
      const facts = dailyFixture();
      return { ...facts, date: '2026-09-28', account: { ...facts.account, date: '2026-09-28' } };
    };
    const send = f.transport.send;
    f.transport.send = async () => { throw new Error('send failed'); };
    await assert.rejects(f.bot.tick(new Date('2026-09-29T03:10:00Z')), /send failed/);
    assert.equal(f.store.delivered('daily-report:2026-09-28', now.getTime()), false);
    f.transport.send = send;
    await f.bot.tick(new Date('2026-09-29T03:20:00Z'));
    await f.bot.tick(new Date('2026-09-29T03:30:00Z'));
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /2026-09-28/);
  } finally { f.clean(); }
});

test('existing daily deliveries survive upgrade and missed reports expire after an hour', async () => {
  const f = fixture();
  const now = new Date('2026-09-26T03:00:00Z');
  f.store.state.dailyTime = '11:00';
  f.source.dailyFacts = async () => { throw new Error('should not load'); };
  try {
    await f.bot.tick(new Date('2026-09-26T02:59:00Z'));
    await f.bot.tick(new Date('2026-09-26T04:00:00Z'));
    f.store.markDelivered('daily:2026-09-26', now.getTime());
    await f.bot.tick(now);
    assert.equal(f.sent.length, 0);
    // Skipping weekend reports must still allow configured data alerts.
    f.store.state.alerts = true;
    f.state.status.stale = true;
    await f.bot.tick(new Date('2026-09-27T03:00:00Z'));
    assert.equal(f.sent.length, 1);
    assert.ok(f.sent[0].key.startsWith('alert:'));
  } finally { f.clean(); }
});

test('only the paired owner can query; group, bot and old events are ignored', async () => {
  const f = fixture();
  try {
    await f.bot.receive({ ...message('持仓'), sender_id: 'ou_other' });
    await f.bot.receive({ ...message('持仓'), chat_type: 'group' });
    await f.bot.receive({ ...message('持仓'), sender_type: 'bot' });
    await f.bot.receive({ ...message('持仓'), create_time: '1' });
    assert.equal(f.sent.length, 0);
    f.state.status.stale = true;
    assert.deepEqual(f.acknowledged, []);
    await f.bot.receive(message('摘要'));
    assert.equal(f.sent[0].to, 'ou_owner');
    assert.match(f.sent[0].text, /1,000 USD/);
    assert.match(f.sent[0].text, /快照已过期/);
  } finally { f.clean(); }
});

test('pairing requires a valid one-time code and persists the owner', async () => {
  const f = fixture('');
  try {
    await f.bot.receive(message('摘要'));
    await f.bot.receive(message('绑定 invalid'));
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.acknowledged, []);
    const pairing = f.store.pairingInfo()!;
    await f.bot.receive(message(pairing.command));
    assert.equal(f.store.state.ownerOpenId, 'ou_owner');
    assert.equal(f.store.pairingInfo(), null);
    assert.equal(new BotStore(f.directory, 'test').state.ownerOpenId, 'ou_owner');
    assert.equal(fs.statSync(path.join(f.directory, 'feishu-bot.json')).mode & 0o777, 0o600);
    assert.throws(() => new BotStore(f.directory, 'other'));
  } finally { f.clean(); }
});

test('data alerts emit only on freshness changes and preferences are persistent', async () => {
  const f = fixture();
  try {
    await f.bot.receive(message('开启提醒'));
    f.state.status.stale = true;
    await f.bot.tick();
    await f.bot.tick();
    assert.equal(f.sent.filter(s => s.key.startsWith('alert:')).length, 1);
    f.state.status.stale = false;
    await f.bot.tick();
    assert.equal(f.sent.filter(s => s.key.startsWith('alert:')).length, 2);
    await f.bot.receive(message('关闭提醒'));
    f.state.status.stale = true;
    await f.bot.tick();
    assert.equal(f.sent.filter(s => s.key.startsWith('alert:')).length, 2);
    await f.bot.receive(message('偏好 保留半年生活费作为现金'));
    assert.equal(new BotStore(f.directory, 'test').state.preferences, '保留半年生活费作为现金');
    await f.bot.receive(message('清除偏好'));
    assert.equal(new BotStore(f.directory, 'test').state.preferences, '');
  } finally { f.clean(); }
});

test('login alerts run during a blocked model reply and stay enabled after alerts off', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  const entered = Promise.withResolvers<void>(), answer = Promise.withResolvers<string>();
  let failed = false;
  const bot = new PortfolioBot(f.config, f.store, {
    ...f.source, authStatus: broker => failed && broker === 'schwab' ? 'login_required' : 'ready',
  }, f.transport, { configured: true, name: 'fixture', answer: async () => { entered.resolve(); return answer.promise; } });
  try {
    await bot.receive(message('/alerts off'));
    assert.match(f.sent.at(-1)!.text, /登录失效提醒始终自动开启/);
    bot.start();
    await bot.loginAlerts.check();
    const work = bot.receive(message('分析一下目前的仓位'));
    await entered.promise;
    failed = true;
    t.mock.timers.tick(30000);
    await bot.loginAlerts.check();
    assert.equal(f.sent.filter(row => row.key.startsWith('login-alert:')).length, 1);
    assert.ok(bot.status().loginAlerts.running);
    answer.resolve('模型回复');
    await work;
  } finally { answer.resolve('结束'); await bot.stop(); f.clean(); }
  assert.equal(bot.status().loginAlerts.running, false);
});

test('daily failures cannot stop login alerts', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  let failed = false;
  f.store.state.dailyTime = '11:00';
  f.source.dailyFacts = async () => { throw new Error('daily unavailable'); };
  const bot = new PortfolioBot(f.config, f.store, {
    ...f.source, authStatus: broker => failed && broker === 'ibkr' ? 'login_required' : 'ready',
  }, f.transport, { configured: false, name: 'fixture', answer: async () => '' });
  try {
    bot.start();
    await bot.loginAlerts.check();
    await assert.rejects(bot.tick(new Date('2026-10-27T03:00:00Z')), /daily unavailable/);
    failed = true;
    t.mock.timers.tick(30000);
    await bot.loginAlerts.check();
    assert.equal(f.sent.filter(row => row.key.startsWith('login-alert:')).length, 1);
  } finally { await bot.stop(); f.clean(); }
});

test('legacy data alerts suppress auth outages and do not emit a fake recovery', async () => {
  const f = fixture();
  try {
    f.store.state.alerts = true;
    f.store.state.lastHealth = 'auth';
    f.state.status.connected = false;
    f.state.status.stale = true;
    await f.bot.tick();
    assert.equal(f.sent.length, 0);
    f.state.status.connected = true;
    f.state.status.stale = false;
    await f.bot.tick();
    assert.equal(f.sent.length, 0);
    f.state.status.stale = true;
    await f.bot.tick();
    assert.equal(f.sent.length, 1);
  } finally { f.clean(); }
});

test('model configuration rejects credential URLs and nonlocal HTTP', () => {
  assert.throws(() => readModelConfig({ MODEL_BASE_URL: 'http://example.com/v1' }));
  assert.throws(() => readModelConfig({ MODEL_BASE_URL: 'https://key@example.com' }));
  assert.throws(() => readModelConfig({ MODEL_BASE_URL: 'https://example.com/?key=x' }));
  assert.doesNotThrow(() => readModelConfig({ MODEL_BASE_URL: 'http://127.0.0.1:11434/v1' }));
  assert.throws(() => readBotConfig({ FEISHU_ENABLED: 'true' }, { publicUrl: 'http://127.0.0.1:8048', dataDir: '/tmp' }));
});

test('compatible model sends account facts and preferences without credentials or tools', async () => {
  const f = fixture();
  try {
    let calls = 0;
    Object.assign(f.state, { access_token: 'IB-SECRET' });
    const config = readModelConfig({ MODEL_BASE_URL: 'https://model.example/v1/', MODEL_API_KEY: 'MODEL-TEST-KEY', MODEL_NAME: 'my-model' });
    const mockFetch: typeof fetch = async (input, init) => {
      calls++;
      assert.equal(input, 'https://model.example/v1/chat/completions');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'my-model');
      assert.equal(body.tools, undefined);
      assert.equal(body.store, false);
      assert.match(body.messages[1].content, /1,000 USD/);
      assert.match(body.messages[1].content, /保留现金/);
      assert.doesNotMatch(String(init?.body), /IB-SECRET|MODEL-TEST-KEY|ou_owner/);
      return Response.json({ choices: [{ message: { content: '账户分析结果' } }] });
    };
    const model = new CompatibleModel(config, mockFetch);
    assert.equal(await model.answer('现金够吗？', f.state, '保留现金'), '账户分析结果');
    assert.equal(calls, 1);
    const disabled = new CompatibleModel(readModelConfig({}), mockFetch);
    assert.match(await disabled.answer('问题', f.state, ''), /尚未配置/);
    assert.equal(calls, 1);
    const failing = new CompatibleModel(config, async () => { throw new Error('MODEL-TEST-KEY'); });
    assert.doesNotMatch(await failing.answer('问题', f.state, ''), /MODEL-TEST-KEY/);
  } finally { f.clean(); }
});

test('group access requires an allowed chat, a real bot mention and an allowed member', async () => {
  const f = fixture();
  try {
    f.bot.updateGroups([{ chatId: 'oc_test', name: 'Test', access: 'members', members: [] }]);
    await f.bot.receive({ ...groupMessage('摘要'), mentions: [] });
    await f.bot.receive({ ...groupMessage('摘要'), chat_id: 'oc_other' });
    await f.bot.receive({ ...groupMessage('摘要'), mentions: [{ id: 'ou_otherbot' }] });
    assert.equal(f.sent.length, 0);
    await f.bot.receive(groupMessage('@持仓助手 摘要'));
    assert.equal(f.sent[0].to, 'oc_test');
    assert.match(f.sent[0].text, /1,000 USD/);
    f.bot.updateGroups([{ chatId: 'oc_test', name: 'Test', access: 'allowlist', members: ['ou_allowed'] }]);
    await f.bot.receive(groupMessage('摘要'));
    assert.equal(f.sent.length, 1);
    await f.bot.receive(groupMessage('摘要', 'ou_allowed'));
    assert.equal(f.sent.length, 2);
    assert.equal(new BotStore(f.directory, 'test').state.groups?.[0].access, 'allowlist');
  } finally { f.clean(); }
});

test('group users cannot change private settings, and Beijing time persists', async () => {
  const f = fixture();
  try {
    f.bot.updateGroups([{ chatId: 'oc_test', name: 'Test', access: 'members', members: [] }]);
    await f.bot.receive(groupMessage('每天上午11点给我发日报'));
    assert.equal(f.store.state.dailyTime, null);
    assert.match(f.sent[0].text, /私聊/);
    await f.bot.receive(message('订阅日报北京时间 11:00 发送'));
    const saved = new BotStore(f.directory, 'test').state;
    assert.equal(saved.dailyTime, '11:00');
    assert.equal(saved.dailyTimeZone, 'Asia/Shanghai');
  } finally { f.clean(); }
});

test('multi-turn context is passed to the model and never crosses private/group scopes', async () => {
  const { ConversationMemory } = await import('../server/bot/memory.js');
  const f = fixture();
  try {
    const memory = new ConversationMemory(f.directory);
    const histories: string[][] = [];
    const model = { configured: true, name: 'mock', answer: async (_q: string, _s: unknown, _p: string, _e?: string, history: any[] = []) => {
      histories.push(history.map(m => m.content)); return '记忆测试回答';
    } };
    const bot = new PortfolioBot(f.config, f.store, { view: () => f.state, refresh: async () => {} }, { send: async () => {} }, model, memory);
    await bot.receive(message('私聊第一问'));
    await bot.receive(message('继续上个问题'));
    assert.equal(histories[1].length, 2);
    assert.match(histories[1][0], /私聊第一问/);
    bot.updateGroups([{ chatId: 'oc_test', name: 'Test', access: 'members', members: [] }]);
    await bot.receive(groupMessage('群聊第一问'));
    assert.deepEqual(histories[2], []);
    await bot.receive(groupMessage('清空上下文'));
    assert.equal(memory.read('group:oc_test').length, 2);
    await bot.receive(groupMessage('清空上下文', 'ou_owner'));
    assert.equal(memory.read('group:oc_test').length, 0);
    assert.equal(memory.read('dm:ou_owner').length, 4);
    await bot.receive(message('清空上下文'));
    assert.equal(memory.read('dm:ou_owner').length, 0);
  } finally { f.clean(); }
});
