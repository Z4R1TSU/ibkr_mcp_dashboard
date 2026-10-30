import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { inferCashFlows, withCashFlows } from '../dist/server/cash-flows.js';
import { buildPnlCalendar } from '../dist/server/pnl-calendar.js';
import { normalizeTrades } from '../dist/server/trades.js';
const now = new Date();
const fx = (id, side, size, net, time = '2026-03-31T13:35:59Z') => ({ trade_id: id, sec_type: 'CASH', symbol: 'USD.CNH',
  currency: 'CNH', side, size, price: Math.abs(net / size), net_amount: net, commission: 2, trade_time: time });
const rows = [fx('buy', 'BUY', 13040.67, -90084.94836), fx('sell', 'SELL', 20, 140),
  fx('tiny', 'BUY', 0.0019416, -0.0130125, '2026-09-19T01:42:48Z'),
  fx('weekend', 'SELL', 50, 350, '2026-09-19T14:00:00Z')];
let revision = 0, unavailable = false, cashFlowReads = 0;
const flows = () => inferCashFlows({ trades: normalizeTrades({ trades: rows }), range: 'year', startDate: '2026-01-01',
  endDate: now.toISOString().slice(0, 10), timeZone: 'America/New_York',
  fetchedAt: new Date(now.getTime() + revision).toISOString(), refreshing: false, stale: false, error: null });
const browser = await chromium.launch({ headless: true, channel: 'chromium',
  env: { ...process.env, LD_LIBRARY_PATH: path.resolve('.runtime/tos-browser-libs') } });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), p = url.pathname;
    if (p === '/api/session') return route.fulfill({ json: { authenticated: true, csrf: 'fixture', accessMode: 'password' } });
    if (p === '/api/portfolio') return route.fulfill({ json: { snapshot: null, status: { connected: false }, history: [], quotes: {} } });
    if (p === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (p === '/api/cash-flows/refresh') {
      assert.equal(route.request().headers()['x-csrf-token'], 'fixture');
      rows.push(fx('new', 'BUY', 25, -175)); revision++;
      return route.fulfill({ json: flows() });
    }
    if (p === '/api/cash-flows') {
      cashFlowReads++;
      return route.fulfill({ status: unavailable ? 503 : 200, json: unavailable ? { error: '换汇读取失败' } : flows() });
    }
    if (p === '/api/pnl-calendar') {
      const month = url.searchParams.get('month') || now.toISOString().slice(0, 7);
      const performance = [{ date: '2026-03-31', previousDate: '2026-03-30', startNav: 1000, endNav: 1010,
        returnPct: 1, source: 'ib-pa', fetchedAt: now.toISOString() }];
      return route.fulfill({ json: withCashFlows(buildPnlCalendar(month, 'USD', performance, undefined, now), flows()) });
    }
    const file = p === '/' ? 'index.html' : p.replace(/^\//, '');
    if (!file.startsWith('assets/') && file !== 'index.html') return route.abort();
    return route.fulfill({ path: path.resolve('dist/client', file) });
  });
  await page.goto('http://dashboard.test/');
  const toggle = page.locator('#cash-flows .cash-flow-toggle');
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#pnl-calendar .pnl-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#cash-flow-content').isVisible(), false);
  assert.equal(cashFlowReads, 0, 'collapsed records do not load data');
  await toggle.click();
  await page.locator('#cash-flows tbody tr').first().waitFor();
  assert.equal(await page.locator('#cash-flows tbody tr').count(), 4);
  assert.deepEqual(await page.locator('.cash-flow-rate dd').allTextContents(), ['6.9080', '7.0000']);
  await toggle.click();
  assert.equal(await page.locator('#cash-flow-content').isVisible(), false);
  await page.getByRole('link', { name: '入金记录', exact: true }).click();
  await page.locator('#cash-flows tbody tr').first().waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.getByRole('link', { name: '盈亏日历', exact: true }).click();
  await page.getByRole('button', { name: '出金', exact: true }).click();
  assert.equal(await page.locator('#cash-flows tbody tr').count(), 2);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByLabel('日历月份').selectOption('2026-03');
  const march = page.getByRole('button', { name: /^2026-03-31，/ });
  await march.locator('.pnl-cell-flows').waitFor();
  assert.equal(await march.locator('.pnl-cell-flows > span').count(), 2);
  assert.equal(await march.locator('strong').innerText(), '+10.00');
  await page.getByRole('button', { name: '收益率', exact: true }).click();
  assert.equal(await march.locator('strong').innerText(), '+1.00%');
  assert.equal(await march.locator('.pnl-cell-flows > span').count(), 2);
  await page.getByRole('button', { name: '金额', exact: true }).click();
  await march.click();
  assert.match(await page.getByLabel('当日入出金参考').innerText(), /13,040.67/);
  await page.locator('#pnl-calendar').screenshot({ path: '/tmp/ibkr-cash-flows-calendar-desktop.png' });
  await page.getByRole('button', { name: '刷新换汇', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#cash-flows tbody tr').length === 5);
  await page.waitForFunction(() => document.querySelector('.pnl-flow-summary').textContent.includes('13,065.67'));
  await page.getByLabel('日历月份').selectOption('2026-09');
  const tiny = page.getByRole('button', { name: /^2026-09-18，/ });
  await tiny.locator('.pnl-cell-flows').waitFor();
  assert.match(await tiny.innerText(), /<0.01/);
  await tiny.click();
  assert.match(await page.getByLabel('当日入出金参考').innerText(), /0.0019416/);
  const weekend = page.getByRole('button', { name: /^2026-09-19，/ });
  await weekend.click();
  assert.match(await page.getByLabel('当日入出金参考').innerText(), /出金/);
  assert.match(await weekend.innerText(), /休市/);
  assert.equal(await weekend.isEnabled(), true);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#pnl-calendar').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page must fit mobile');
    assert.equal(await page.locator('.sidebar').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'navigation must fit mobile');
    await page.locator('#pnl-calendar').screenshot({ path: '/tmp/ibkr-cash-flows-calendar-' + width + '.png' });
  }
  await page.getByLabel('日历月份').selectOption('2026-08');
  await page.waitForFunction(() => document.querySelector('select[aria-label="日历月份"]').value === '2026-08'
    && !document.querySelector('.pnl-flow-summary'));
  assert.equal(await page.locator('.pnl-cell-flows').count(), 0);
  assert.equal(await page.locator('.pnl-detail-flows').count(), 0);
  await page.locator('#cash-flows').screenshot({ path: '/tmp/ibkr-cash-flows-records-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#cash-flows').screenshot({ path: '/tmp/ibkr-cash-flows-records-desktop.png' });
  unavailable = true;
  await page.reload();
  await page.getByRole('link', { name: '入金记录', exact: true }).click();
  await page.locator('#cash-flows .cash-flow-notice').waitFor();
  assert.match(await page.locator('#cash-flows').innerText(), /暂时无法取得换汇记录/);
  assert.doesNotMatch(await page.locator('#cash-flows .cash-flow-summary').innerText(), /0\.00/);
  assert.deepEqual(errors, []);
  console.log('PASS: default collapse, toggle/navigation, weighted FX rates, funding filters, calendar synchronization, precise details, failure state, desktop/mobile layout.');
} finally { await browser.close(); }
