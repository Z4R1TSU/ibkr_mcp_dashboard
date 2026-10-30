import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.argv[2]);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-market-browser-'));
let displayProcess, chrome, browser;
const stopChildren = () => { chrome?.kill('SIGTERM'); displayProcess?.kill('SIGTERM'); };
process.once('exit', stopChildren);
process.once('SIGTERM', () => process.exit(1));
process.once('SIGINT', () => process.exit(1));

async function displayEnvironment() {
  const env = { ...process.env };
  if (process.platform !== 'linux') return env;
  const runtime = path.join(root, '.runtime/tos-xvfb/root');
  env.LD_LIBRARY_PATH = process.env.DAILY_BROWSER_LIBRARY_PATH
    || [path.join(runtime, 'usr/lib/x86_64-linux-gnu'), path.join(root, '.runtime/tos-browser-libs')].join(':');
  let display = 130;
  while (fs.existsSync('/tmp/.X' + display + '-lock') && display < 250) display++;
  const field = value => {
    const data = Buffer.from(value), length = Buffer.alloc(2);
    length.writeUInt16BE(data.length); return Buffer.concat([length, data]);
  };
  env.DISPLAY = ':' + display;
  env.XAUTHORITY = path.join(temporary, 'Xauthority');
  fs.writeFileSync(env.XAUTHORITY, Buffer.concat([Buffer.from([255, 255]), field(''), field(String(display)),
    field('MIT-MAGIC-COOKIE-1'), field(randomBytes(16))]), { mode: 0o600 });
  const local = path.join(runtime, 'usr/bin/Xvfb');
  const executable = process.env.DAILY_XVFB_PATH || (fs.existsSync(local) ? local : '/usr/bin/Xvfb');
  displayProcess = spawn(executable, [':' + display, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-auth', env.XAUTHORITY], { env, stdio: 'ignore' });
  let failed = false;
  displayProcess.on('error', () => { failed = true; });
  await new Promise(resolve => setTimeout(resolve, 1200));
  if (failed || displayProcess.exitCode !== null) throw new Error('Display unavailable');
  return env;
}

try {
  const env = await displayEnvironment();
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const executable = process.env.DAILY_CHROMIUM_PATH || chromium.executablePath();
  // Use a separate browser for public data, with no account/login cookies.
  chrome = spawn(executable, ['--no-sandbox', '--no-first-run', '--user-data-dir=' + directory,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, 'about:blank'], { env, stdio: 'ignore' });
  let failed = false;
  chrome.on('error', () => { failed = true; });
  for (let attempt = 0; attempt < 20; attempt++) {
    if (failed || chrome.exitCode !== null) throw new Error('Browser unavailable');
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 1000 }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!browser) throw new Error('Browser unavailable');
  const page = await browser.contexts()[0].newPage();
  const results = {};
  for (const metric of ['pe-ratio', 'forward-pe-ratio']) {
    try {
      await page.goto('https://trendonify.com/united-states/stock-market/nasdaq-100/' + metric,
        { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('NASDAQ-100'),
        undefined, { timeout: 40000 });
      results[metric] = await page.evaluate(() => {
        const heading = document.querySelector('h1')?.textContent?.trim();
        const table = [...document.querySelectorAll('table')].find(t => t.getAttribute('aria-label') === 'Comparison table for ' + heading);
        return { heading, text: document.body.innerText,
          headers: [...(table?.querySelectorAll('thead th') ?? [])].map(cell => cell.textContent?.trim()),
          rows: [...(table?.querySelectorAll('tbody tr') ?? [])].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent?.trim())) };
      });
    } catch { results[metric] = null; }
  }
  console.log(JSON.stringify(results));
} catch {
  console.log(JSON.stringify({ 'pe-ratio': null, 'forward-pe-ratio': null }));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  stopChildren();
  fs.rmSync(temporary, { recursive: true, force: true });
}
