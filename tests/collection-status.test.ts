import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionLabel, collectionSchedule } from '../shared/collection-status.js';
import type { DashboardState } from '../shared/types.js';

test('queue, account reading, quotes and retry waits have distinct labels', () => {
  const status = { connected: true, refreshing: true, phase: 'queued', error: null,
    lastAttempt: '2026-10-15T12:00:00Z', nextAttempt: null, pollSeconds: 60 } as DashboardState['status'];
  assert.equal(collectionLabel(status, true), '等待 IB 请求');
  assert.equal(collectionSchedule(status, Date.parse('2026-10-15T12:00:45Z')), '本次已用时 45 秒');
  status.phase = 'summary';
  assert.equal(collectionLabel(status, true), '正在读取净值');
  status.refreshing = false; status.phase = 'quotes';
  assert.equal(collectionLabel(status, false), '账户已采集 · 更新行情');
  status.phase = 'idle'; status.error = 'failed'; status.nextAttempt = '2026-10-15T12:01:15Z';
  assert.equal(collectionLabel(status, true), '读取失败 · 等待重试');
  assert.equal(collectionSchedule(status, Date.parse('2026-10-15T12:00:45Z')), '重试倒计时 0:30');
});

test('closed-market waits show the next read time instead of an hours-long countdown', () => {
  const status = { connected: true, refreshing: false, phase: 'idle', error: null,
    lastAttempt: '2026-10-17T13:00:00Z', nextAttempt: '2026-10-17T18:00:00Z', pollSeconds: 60 } as DashboardState['status'];
  assert.equal(collectionSchedule(status, Date.parse('2026-10-17T13:00:05Z')), '休市低频采集 · 下次 10/18 02:00');
  status.nextAttempt = '2026-10-17T13:01:00Z';
  assert.equal(collectionSchedule(status, Date.parse('2026-10-17T13:00:05Z')), '下次采集倒计时 0:55');
});
