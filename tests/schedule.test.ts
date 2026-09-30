import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailySchedule } from '../server/bot/schedule.js';

test('daily schedule accepts the reported Beijing phrase and common Chinese forms', () => {
  for (const text of ['订阅日报北京时间 11:00 发送', '订阅日报 北京时间１１：００发送', '每天上午11点给我发日报']) {
    assert.deepEqual(parseDailySchedule(text, 'Asia/Shanghai'), { kind: 'valid', time: '11:00', timeZone: 'Asia/Shanghai' });
  }
  assert.deepEqual(parseDailySchedule('订阅日报北京时间 11:00 发送', 'America/New_York'), { kind: 'valid', time: '11:00', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(parseDailySchedule('订阅日报 下午3点半', 'Asia/Shanghai'), { kind: 'valid', time: '15:30', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(parseDailySchedule('订阅日报 9:00', 'Asia/Shanghai'), { kind: 'valid', time: '09:00', timeZone: 'Asia/Shanghai' });
});

test('ambiguous, invalid and unsupported times do not silently create subscriptions', () => {
  for (const text of ['订阅日报 25:00', '订阅日报 11:99', '订阅日报 11:00 或 12:00', '订阅日报纽约时间11:00', '订阅日报']) {
    assert.deepEqual(parseDailySchedule(text, 'Asia/Shanghai'), { kind: 'invalid' });
  }
  for (const text of ['取消日报', '日报里显示11:00是什么意思', '不要订阅日报 11:00']) {
    assert.deepEqual(parseDailySchedule(text, 'Asia/Shanghai'), { kind: 'none' });
  }
});
