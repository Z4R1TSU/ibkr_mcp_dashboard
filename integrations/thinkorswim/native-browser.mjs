import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const localPort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

/** Ordinary interactive Chrome; its debugging endpoint is loopback-only and ends with login. */
export async function launchNativeBrowser({ profile, proxy, env, executable = chromium.executablePath() }) {
  if (proxy?.username || proxy?.password) throw new Error('native_browser_requires_unauthenticated_proxy');
  const port = await localPort();
  let browser, closing, spawnError;
  const child = spawn(executable, ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    ...(proxy?.server ? ['--proxy-server=' + proxy.server] : []), 'about:blank'], { env, stdio: 'ignore' });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  child.on('error', error => { spawnError = error; });
  const close = () => closing ??= (async () => {
    if (browser?.isConnected()) {
      try { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close'); } catch {}
    }
    await browser?.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null && !spawnError) child.kill('SIGTERM');
    await Promise.race([exited, delay(2000)]);
    if (child.exitCode === null && child.signalCode === null && !spawnError) child.kill('SIGKILL');
  })();
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('chrome_exited');
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 1000 }); break; } catch {}
      await delay(250);
    }
    if (!browser) throw new Error('chrome_not_ready');
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    return { context: browser.contexts()[0], close };
  } catch {
    await close();
    throw new Error('native_browser_start_failed');
  }
}
