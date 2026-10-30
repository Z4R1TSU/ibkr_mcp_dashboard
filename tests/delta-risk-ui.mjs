import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { normalizeSnapshot } from '../dist/server/normalize.js';
import { calculateDeltaRisk } from '../dist/server/delta-risk.js';
const now = Date.parse('2026-10-23T14:00:00Z'), time = new Date(now).toISOString();
const snapshot = normalizeSnapshot({ positions: [
  { contract_id: 1, contract_description: 'AAPL', asset_class: 'STK', currency: 'USD', position: 100, market_value: 10000, market_price: 100 },
  { contract_id: 2, contract_description: 'AAPL [AAPL 261218C00100000 100]', asset_class: 'OPT', currency: 'USD', position: -1, market_value: -200, market_price: 2 },
] }, { currency: 'USD', net_liquidation: 10000, total_cash_value: 200 }, { balances: [] }, { positions: time, summary: time, balances: time });
const observation = value => ({ value, receivedAt: time, sourceTime: null, source: 'thinkorswim', status: 'REALTIME' });
let risk = calculateDeltaRisk(snapshot, { 1: { price: observation(100), delta: null }, 2: { price: observation(100), delta: observation(.3) } }, now, 180);
const browser = await chromium.launch({ headless: true, channel: 'chromium', env: { ...process.env, LD_LIBRARY_PATH: path.resolve('.runtime/tos-browser-libs') } });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/session') return route.fulfill({ json: { authenticated: true, csrf: 'fixture', accessMode: 'password' } });
    if (p === '/api/portfolio') return route.fulfill({ json: { snapshot, deltaRisk: risk, quotes: {}, history: [], status: { connected: true, stale: false, pollSeconds: 60, quoteBatchSize: 4 } } });
    if (p === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (p.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'fixture' } });
    return route.fulfill({ path: path.resolve('dist/client', p === '/' ? 'index.html' : p.slice(1)) });
  });
  await page.goto('http://dashboard.test/');
  const panel = page.locator('.delta-panel');
  await panel.waitFor();
  assert.match(await panel.innerText(), /0\.7×/);
  assert.match(await panel.innerText(), /数据完整性/);
  assert.match(await panel.innerText(), /与 Call 是否备兑无关/);
  assert.equal(await panel.locator('tbody tr').first().locator('td').nth(2).innerText(), '-30');
  assert.equal(await panel.locator('tbody tr').first().locator('td').nth(3).innerText(), '70');
  await panel.locator('summary').click();
  await panel.screenshot({ path: '/tmp/ibkr-delta-risk-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: '/tmp/ibkr-delta-risk-mobile.png' });
  const closedAt = Date.parse('2026-10-29T06:00:00Z'), closedTime = new Date(closedAt).toISOString();
  snapshot.sources = { positions: closedTime, summary: closedTime, balances: closedTime };
  const closedObservation = value => ({ ...observation(value), receivedAt: closedTime });
  risk = calculateDeltaRisk(snapshot, { 1: { price: closedObservation(100), delta: null },
    2: { price: closedObservation(100), delta: closedObservation(.3) } }, closedAt, 180);
  await page.reload();
  await panel.waitFor();
  assert.match(await panel.innerText(), /休市参考/);
  assert.match(await panel.locator('.delta-metrics strong').first().innerText(), /0\.7×/);
  const overview = page.locator('.nav-metrics > div').filter({ hasText: '整体 Delta 杠杆' });
  assert.match(await overview.innerText(), /0\.7×/);
  assert.match(await overview.innerText(), /休市参考/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.screenshot({ path: '/tmp/ibkr-delta-closed-reference.png' });
  risk = { ...risk, leverage: null, netLeverage: null, status: 'incomplete', reason: '部分持仓行情缺失或过期' };
  await page.reload();
  await panel.waitFor();
  assert.match(await panel.innerText(), /数据未齐/);
  assert.equal(await panel.locator('.delta-metrics strong').first().innerText(), '—');
  risk = { ...risk, status: 'reference', leverage: .7, netLeverage: .7, requiresLogin: true,
    reason: '嘉信会话已失效，需要重新登录', latestAttempt: { at: time, covered: 0, total: 2, reason: '嘉信需要重新登录' } };
  await page.reload();
  await panel.waitFor();
  assert.match(await panel.innerText(), /上次完整/);
  assert.match(await panel.locator('.delta-metrics strong').first().innerText(), /0\.7×/);
  assert.match(await panel.getByRole('status').innerText(), /持仓、行情和净值均沿用该快照/);
  assert.equal(await panel.getByRole('link', { name: '重新连接嘉信行情' }).getAttribute('href'), '/tos-login/');
  assert.match(await panel.innerText(), /当前行情可用 0\/2 项/);
  risk = { ...risk, requiresLogin: false, reason: '嘉信行情连接中断，正在重连' };
  await page.reload();
  await panel.waitFor();
  assert.equal(await panel.getByRole('link', { name: '检查嘉信连接' }).getAttribute('href'), '/tos-login/');
  assert.match(await panel.locator('.delta-metrics strong').first().innerText(), /0\.7×/);
  assert.deepEqual(errors, []);
  console.log('Delta desktop/mobile, covered-call display and incomplete coverage passed.');
} finally { await browser.close(); }
