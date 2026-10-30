import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlashCommand, SLASH_COMMANDS } from '../server/bot/slash-commands.js';

test('slash shortcuts map only explicit commands and reject unexpected arguments', () => {
  assert.equal(resolveSlashCommand('解释一下 /risk 的意思'), null);
  assert.equal(resolveSlashCommand('深度研究 AAPL'), null);
  assert.deepEqual(resolveSlashCommand('/DASHBOARD'), { text: '看板' });
  assert.deepEqual(resolveSlashCommand('/positions'), { text: '持仓' });
  assert.deepEqual(resolveSlashCommand('/fx'), { text: '今年换汇' });
  assert.deepEqual(resolveSlashCommand('/LOGIN'), { text: '连接 IB' });
  assert.deepEqual(resolveSlashCommand('/login extra'), { error: '用法：/login' });
  assert.match((resolveSlashCommand('/risk extra') as { error: string }).error, /用法/);
  assert.match((resolveSlashCommand('/buy AAPL') as { error: string }).error, /未知/);
  assert.equal(new Set(SLASH_COMMANDS.map(c => c.name)).size, SLASH_COMMANDS.length);
});

test('slash management arguments are explicit and research keeps its existing parser', () => {
  assert.deepEqual(resolveSlashCommand('/daily'), { text: '日报' });
  assert.deepEqual(resolveSlashCommand('/daily 9:30'), { text: '订阅日报北京时间 09:30 发送' });
  assert.deepEqual(resolveSlashCommand('/daily off'), { text: '取消日报' });
  assert.match((resolveSlashCommand('/daily 25:00') as { error: string }).error, /用法/);
  assert.deepEqual(resolveSlashCommand('/alerts on'), { text: '开启提醒' });
  assert.deepEqual(resolveSlashCommand('/memory clear'), { text: '清空上下文' });
  assert.deepEqual(resolveSlashCommand('/research AAPL'), { text: '/research AAPL' });
});
