import path from 'node:path';
import { launchNativeBrowser } from './native-browser.mjs';
import { config, directory, save } from './login-storage.mjs';
import { startDisplay } from './display.mjs';
import { observeLogin, WS_URL } from './login-policy.mjs';

export class BrowserLogin {
  status = { state: 'idle' };
  context = null;
  page = null;
  display = null;
  nativeBrowser = null;
  viewSize = { width: 1280, height: 900 };
  timer = null;
  observe() {
    observeLogin(this.context, this.status, raw => this.capture(raw));
    this.context.on('page', page => {
      this.page = page;
      page.on('close', () => {
        if (this.page === page) this.page = this.context?.pages().at(-1) ?? null;
      });
    });
  }

  capture(raw) {
    try {
      const frame = JSON.parse(String(raw));
      for (const row of frame.payload || []) {
        const b = row.body;
        if (!['login', 'login/schwab'].includes(row.header?.service) || !b) continue;
        if ((b.authenticated === true || b.authenticationStatus === 'OK') && typeof b.token === 'string') {
          save('session.json', { token: b.token, wsUrl: WS_URL, obtainedAt: new Date().toISOString() });
          this.status.state = 'authenticated';
          setTimeout(() => void this.stop('authenticated'), 500);
        }
      }
    } catch { /* Authentication payloads are never logged. */ }
  }

  async input(value) {
    if (!this.page || !['login', 'login_page_rejected', 'verification', 'manual_required', 'waiting_mobile', 'login_failed'].includes(this.status.state)) return false;
    if (value.type === 'click' && Number.isFinite(value.x) && Number.isFinite(value.y)
        && value.x >= 0 && value.x < this.viewSize.width && value.y >= 0 && value.y < this.viewSize.height) {
      await this.page.mouse.click(value.x, value.y);
    } else if (value.type === 'text' && typeof value.text === 'string' && value.text.length <= 512) {
      await this.page.keyboard.insertText(value.text);
    } else if (value.type === 'key' && ['Tab', 'Shift+Tab', 'Enter', 'Backspace', 'Delete',
        'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape', 'Control+a'].includes(value.key)) {
      await this.page.keyboard.press(value.key);
    } else if (value.type === 'scroll' && Number.isFinite(value.delta)) {
      await this.page.mouse.wheel(0, Math.max(-900, Math.min(900, value.delta)));
    } else return false;
    return true;
  }

  async frame() {
    if (!this.page) return null;
    this.viewSize = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    return this.page.screenshot({ type: 'jpeg', quality: 80, timeout: 5000 });
  }

  async stop(state = 'idle') {
    clearTimeout(this.timer);
    const context = this.context, native = this.nativeBrowser;
    this.nativeBrowser = null;
    this.context = this.page = null;
    if (native) await native.close().catch(() => {});
    else await context?.close().catch(() => {});
    this.display?.stop();
    this.display = null;
    this.status.state = state;
  }
  async start() {
    if (this.context || this.status.state === 'starting') return;
    this.status = { state: 'starting' };
    try {
      this.display = await startDisplay();
      const raw = config.TOS_HTTP_PROXY || config.TRADINGAGENTS_HTTP_PROXY || config.IBKR_HTTP_PROXY;
      const p = raw ? new URL(raw) : null;
      const proxy = p ? { server: p.protocol + '//' + p.host,
        username: decodeURIComponent(p.username), password: decodeURIComponent(p.password) } : undefined;
      this.nativeBrowser = await launchNativeBrowser({ profile: path.join(directory, 'chromium-native-profile'), proxy, env: this.display.env });
      this.context = this.nativeBrowser.context;
      this.observe();
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.status.state = 'login';
      this.timer = setTimeout(() => void this.stop('expired'), 30 * 60 * 1000);
      await this.page.goto('https://trade.thinkorswim.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch {
      await this.stop('browser_error');
    }
  }
}
