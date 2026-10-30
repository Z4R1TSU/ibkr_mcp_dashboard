// Open the normal login page using its existing browser profile; never fill credentials.
import { BrowserLogin } from '../integrations/thinkorswim/login-browser.mjs';
import { LoginForm } from '../integrations/thinkorswim/login-form.mjs';
const browser = new BrowserLogin();
try {
  await browser.start();
  const form = new LoginForm(browser);
  for (let i = 0; i < 12; i++) {
    if (['authenticated', 'browser_error', 'login_page_rejected'].includes(browser.status.state)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const inspected = await form.inspect();
  console.log(JSON.stringify({ state: browser.status.state, step: inspected.stage ?? null,
    recovered: browser.status.state === 'authenticated' }));
} finally { await browser.stop(); }
