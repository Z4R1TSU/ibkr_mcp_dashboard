const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class LoginForm {
  constructor(browser) { this.browser = browser; this.busy = false; }
  async find(selector) {
    for (const frame of this.browser.page?.frames() || []) {
      for (const element of await frame.locator(selector).all().catch(() => [])) {
        if (await element.isVisible().catch(() => false)) return { frame, element };
      }
    }
    return null;
  }
  async clickText(pattern) {
    for (const frame of this.browser.page?.frames() || []) {
      const locator = frame.getByText(pattern, { exact: true });
      for (const element of await locator.all()) {
        if (await element.isVisible().catch(() => false)) {
          await element.click({ timeout: 5000 }); return true;
        }
      }
    }
    return false;
  }
  async submit(frame) {
    const direct = frame.locator('button#continueBtn, button[type=submit], input[type=submit]').first();
    if (await direct.isVisible().catch(() => false)) await direct.click({ timeout: 5000 });
    else if (!await this.clickText(/^(continue|next|log in|sign in|verify|submit)$/i)) throw new Error('manual_required');
  }
  async credentials(data) {
    if (this.busy) return false;
    if (typeof data.username !== 'string' || !data.username.trim() || data.username.length > 128
        || typeof data.password !== 'string' || !data.password || data.password.length > 512) throw new Error('invalid_input');
    this.busy = true;
    this.trust = data.trustDevice === true;
    try {
      if (!this.browser.page) await this.browser.start();
      if (!this.browser.page) return false;
      this.browser.status.state = 'submitting';
      let submittedUser = false;
      for (let i = 0; i < 50; i++) {
        if (this.browser.status.state === 'authenticated') return true;
        if (!this.browser.page) return false;
        const user = await this.find('input#loginIdInput,input[autocomplete=username],input[name=username],input[name=loginId]');
        const password = await this.find('input[type=password]');
        if (password) {
          if (user) await user.element.fill(data.username.trim(), { timeout: 5000 });
          await password.element.fill(data.password, { timeout: 5000 });
          await this.submit(password.frame);
          this.browser.status.state = 'verification';
          return true;
        }
        if (user && !submittedUser) {
          await user.element.fill(data.username.trim(), { timeout: 5000 });
          await this.submit(user.frame);
          submittedUser = true;
        }
        await pause(600);
      }
      this.browser.status.state = 'manual_required';
      return false;
    } catch {
      this.browser.status.state = 'manual_required';
      return false;
    } finally {
      data.username = data.password = '';
      this.busy = false;
    }
  }
  async inspect() {
    if (this.busy) return { stage: 'submitting', channels: [] };
    const result = { stage: this.browser.status.state, channels: [] };
    if (!this.browser.page) return result;
    for (const frame of this.browser.page.frames()) {
      const flags = await frame.evaluate(() => {
        const text = document.body?.innerText || '';
        const visible = selector => [...document.querySelectorAll(selector)].some(e => e.getBoundingClientRect().width > 0);
        return {
          mobile: /send a mobile notification|mobile (app )?(notification|push)/i.test(text),
          sms: /text message|send a text/i.test(text),
          code: visible('input[inputmode=numeric],input[autocomplete=one-time-code],input[name*=code i],input[id*=code i]'),
          invalid: /incorrect password|invalid password|invalid login|unable to log|account.*locked/i.test(text),
          waiting: /approve.*(notification|request)|notification.*sent|check your.*(phone|mobile)/i.test(text),
        };
      }).catch(() => ({}));
      if (flags.mobile && !result.channels.includes('mobile')) result.channels.push('mobile');
      if (flags.sms && !result.channels.includes('sms')) result.channels.push('sms');
      if (flags.code) result.stage = 'code';
      else if (flags.invalid) result.stage = 'login_failed';
      else if (flags.waiting) result.stage = 'waiting_mobile';
    }
    if (result.channels.length && !['code', 'login_failed', 'waiting_mobile'].includes(result.stage)) result.stage = 'factor';
    return result;
  }
  async factor(kind) {
    if (this.busy || !['mobile', 'sms'].includes(kind)) return false;
    this.busy = true;
    try {
      for (const frame of this.browser.page?.frames() || []) {
        const checkbox = frame.getByRole('checkbox', { name: /trust (this )?(device|browser|computer)|remember (this )?device/i }).first();
        if (await checkbox.isVisible().catch(() => false)) await checkbox.setChecked(Boolean(this.trust), { timeout: 3000 });
      }
      const pattern = kind === 'mobile' ? /^(send a mobile notification|mobile notification)$/i : /^(text message|send a text|sms)$/i;
      if (!await this.clickText(pattern)) throw new Error('manual_required');
      if (!await this.find('input[inputmode=numeric],input[autocomplete=one-time-code],input[name*=code i],input[id*=code i]')) {
        await this.clickText(/^(continue|send|next)$/i);
      }
      this.browser.status.state = kind === 'mobile' ? 'waiting_mobile' : 'verification';
      return true;
    } catch {
      this.browser.status.state = 'manual_required';
      return false;
    } finally { this.busy = false; }
  }
  async code(data) {
    if (this.busy || typeof data.code !== 'string' || !/^\d{4,8}$/.test(data.code)) return false;
    this.busy = true;
    try {
      const target = await this.find('input[inputmode=numeric],input[autocomplete=one-time-code],input[name*=code i],input[id*=code i]');
      if (!target) throw new Error('manual_required');
      await target.element.fill(data.code, { timeout: 5000 });
      await this.submit(target.frame);
      this.browser.status.state = 'verification';
      return true;
    } catch {
      this.browser.status.state = 'manual_required';
      return false;
    } finally { data.code = ''; this.busy = false; }
  }
}
