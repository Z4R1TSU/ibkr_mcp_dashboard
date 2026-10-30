import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../integrations/thinkorswim/node_modules/playwright-core/index.mjs';
import { observeLogin } from '../integrations/thinkorswim/login-policy.mjs';
import { LoginForm } from '../integrations/thinkorswim/login-form.mjs';
const browser = await chromium.launch({ headless: true, channel: 'chromium',
  env: { ...process.env, LD_LIBRARY_PATH: new URL('../.runtime/tos-browser-libs', import.meta.url).pathname } });
try {
  const page = await browser.newPage();
  let frames = 0, submissions = 0, stage = 'idle', failCredentials = false, preview = null;
  const forwarded = [];
  await page.route('**/*', async route => {
    const request = route.request(), p = new URL(request.url()).pathname;
    if (p === '/api/session') return route.fulfill({ json: { csrf: 'test-csrf' } });
    if (p === '/tos-login/status') return route.fulfill({ json: { state: stage, stage, channels: ['mobile', 'sms'] } });
    if (p === '/tos-login/frame') { frames++; return preview ? route.fulfill({ body: preview, contentType: 'image/png' }) : route.fulfill({ status: 204 }); }
    if (p === '/tos-login/start') return route.fulfill({ json: {ok:true} });
    if (p === '/tos-login/input') { forwarded.push(request.postDataJSON()); return route.fulfill({json:{ok:true}}); }
    if (p === '/tos-login/credentials') {
      submissions++;
      assert.deepEqual(request.postDataJSON(), { username: 'fixture-user', password: 'fixture-password', trustDevice: false });
      assert.equal(request.headers()['x-csrf-token'], 'test-csrf');
      if (failCredentials) return route.fulfill({ status: 503, json: { error: 'browser_unavailable' } });
      stage = 'factor';
      return route.fulfill({ json: { ok: true } });
    }
    const file = p === '/tos-login/' ? 'login.html' : p === '/tos-login/app.js' ? 'login-ui.js' : null;
    if (!file) return route.abort();
    return route.fulfill({ body: fs.readFileSync(new URL('../integrations/thinkorswim/' + file, import.meta.url)),
      contentType: file.endsWith('.html') ? 'text/html' : 'text/javascript' });
  });
  await page.goto('http://portal.test/tos-login/');
  await page.locator('#username').pressSequentially('fixture-user');
  await page.locator('#password').pressSequentially('fixture-password');
  assert.equal(submissions, 0, 'typing must remain local');
  await page.locator('#submit').click();
  await page.locator('#factor').waitFor({ state: 'visible' });
  assert.equal(submissions, 1, 'credentials are sent in one request');
  assert.equal(await page.locator('#password').inputValue(), '');
  assert.equal(await page.locator('#otp').isVisible(), false);
  await page.waitForTimeout(2200);
  assert.equal(frames, 0, 'collapsed fallback must not request screenshots');
  console.log('PASS: local typing, single credential submission, MFA controls, password cleared, zero screenshot requests.');
  const dataUrl = await page.evaluate(() => { const c=document.createElement('canvas');c.width=640;c.height=480;return c.toDataURL(); });
  preview = Buffer.from(dataUrl.split(',')[1], 'base64'); stage = 'login';
  await page.locator('#fallback summary').click();
  await page.waitForFunction(() => document.querySelector('#screen').width === 640);
  const canvas = page.locator('#screen'), box = await canvas.boundingBox();
  const click = page.waitForRequest(r => new URL(r.url()).pathname === '/tos-login/input');
  await canvas.click({position:{x:box.width/2,y:box.height/2}});
  const point = (await click).postDataJSON();
  assert.ok(Math.abs(point.x-320)<2 && Math.abs(point.y-240)<2);
  const count = forwarded.length;
  await canvas.press('Shift');
  await page.waitForTimeout(100);
  assert.equal(forwarded.length,count);
  await page.locator('#fallback summary').click();
  console.log('PASS: native preview dimensions and pointer coordinates stay aligned.');
  stage = 'idle'; failCredentials = true;
  await page.reload();
  await page.locator('#username').fill('fixture-user');
  await page.locator('#password').fill('fixture-password');
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#state').textContent.includes('暂不可用'));
  await page.waitForTimeout(2300);
  assert.match(await page.locator('#state').innerText(), /暂不可用/);
  assert.equal(await page.locator('#submit').isDisabled(), false);

  await page.goto('about:blank');
  await page.setContent('<input id="loginIdInput"><button id="continueBtn">Continue</button>');
  await page.evaluate(() => {
    document.querySelector('button').onclick = () => {
      const password = document.createElement('input'); password.type = 'password';
      const next = document.createElement('button'); next.id = 'continueBtn'; next.textContent = 'Continue';
      next.onclick = () => { document.body.textContent = 'Text Message'; };
      document.body.replaceChildren(password, next);
    };
  });
  const simulated = { page, status: { state: 'login' } };
  const flow = new LoginForm(simulated);
  const credentials = { username: 'fixture-user', password: 'fixture-password' };
  assert.equal(await flow.credentials(credentials), true);
  assert.equal(credentials.password, '');
  assert.equal(credentials.username, '');
  assert.equal((await flow.inspect()).stage, 'factor');
  console.log('PASS: native username/password page progression and sanitized MFA state.');
  await page.setContent('<input id="loginIdInput"><input type="password"><button type="submit">Log In</button>');
  await page.evaluate(() => {
    document.querySelector('button').onclick = () => {
      window.submitted = [document.querySelector('#loginIdInput').value, document.querySelector('input[type=password]').value];
      document.body.textContent = 'Text Message';
    };
  });
  simulated.status.state = 'login';
  const combined = { username: 'fixture-user', password: 'fixture-password' };
  assert.equal(await flow.credentials(combined), true);
  assert.deepEqual(await page.evaluate(() => window.submitted), ['fixture-user', 'fixture-password']);
  assert.equal(combined.password, '');
  const failed = { page: null, status: { state: 'idle' }, start: async function () { this.status.state = 'browser_error'; } };
  const failedInput = { username: 'fixture-user', password: 'fixture-password' };
  assert.equal(await new LoginForm(failed).credentials(failedInput), false);
  assert.equal(failed.status.state, 'browser_error');
  assert.equal(failedInput.password, '');
  console.log('PASS: combined credential form, startup failure, and persistent request errors.');
  const native = await browser.newPage();
  const steps = [];
  await native.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/ui/host/login') return route.fulfill({ contentType: 'text/html', body: `<input id="loginIdInput"><button id="continueBtn">Continue</button><script>
      document.querySelector('button').onclick = async () => {
        for (const step of ['key_exchange','login']) {
          const response = await fetch('/api/v2/auth/'+step,{method:'POST',body:'{}'});
          if (!response.ok) return;
        }
        await fetch('/api/v2/user/data?uid=fixture');
        document.body.innerHTML='<input type="password"><button id="continueBtn">Continue</button>';
        document.querySelector('button').onclick=async()=>{
          await fetch('/api/v2/auth/assert',{method:'POST',body:'{}'});
          await fetch('/api/v2/auth/poll',{method:'POST',body:'{}'});
          document.body.textContent='Text Message';
        };
      };
    </script>` });
    steps.push(url.pathname);
    return route.fulfill({ json: { ok: true } });
  });
  const observed = {};
  observeLogin(native.context(), observed, () => {});
  await native.goto('https://sws-gateway-nr.thinkorswim.com/ui/host/login');
  const nativeFlow = new LoginForm({ page: native, status: {state:'login'} });
  assert.equal(await nativeFlow.credentials({username:'fixture-user',password:'fixture-password'}),true);
  await native.waitForFunction(()=>document.body.textContent==='Text Message');
  assert.deepEqual(steps,['/api/v2/auth/key_exchange','/api/v2/auth/login','/api/v2/user/data','/api/v2/auth/assert','/api/v2/auth/poll']);
  assert.equal(observed.authRequests.length, 5);
  assert.ok(observed.authRequests.every(request => request.status === 200));
  console.log('PASS: username -> password -> verification with passive observation.');

} finally { await browser.close(); }
