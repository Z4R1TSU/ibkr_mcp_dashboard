import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailySchedule, scheduledReportDate } from '../server/bot/schedule.js';

test('scheduled reports follow completed US sessions through holidays and daylight saving changes', () => {
  const cases: [string, string | null][] = [
    ['2026-10-17T03:00:00Z', '2026-10-16'],
    ['2026-10-18T03:00:00Z', null],
    ['2026-10-19T03:00:00Z', null],
    ['2026-10-20T03:00:00Z', '2026-10-19'],
    ['2026-07-04T03:00:00Z', null], // Independence Day observed on Friday.
    ['2026-11-27T03:00:00Z', null], // Thanksgiving.
    ['2026-11-28T03:00:00Z', '2026-11-27'],
    ['2026-03-10T03:00:00Z', '2026-03-09'],
    ['2026-11-03T03:00:00Z', '2026-11-02'],
    ['2026-10-20T05:00:00Z', '2026-10-19'], // After midnight in New York.
    ['2026-10-19T19:59:00Z', null], // Monday before the close.
    ['2026-10-19T20:00:00Z', '2026-10-19'],
    ['2026-11-02T20:59:00Z', null],
    ['2026-11-02T21:00:00Z', '2026-11-02'],
  ];
  for (const [time, date] of cases) assert.equal(scheduledReportDate(new Date(time)), date, time);
});

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
