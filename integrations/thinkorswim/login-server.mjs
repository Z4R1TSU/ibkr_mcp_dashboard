import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { bridgeKey } from './login-storage.mjs';
import { BrowserLogin } from './login-browser.mjs';
import { LoginForm } from './login-form.mjs';
const browser = new BrowserLogin();
const form = new LoginForm(browser);
const expected = Buffer.from('Bearer ' + bridgeKey);
const server = createServer(async (request, response) => {
  const token = Buffer.from(request.headers.authorization || '');
  if (request.headers.host !== '127.0.0.1:8052' || token.length !== expected.length || !timingSafeEqual(token, expected)) {
    response.writeHead(403).end(); return;
  }
  const reply = (status, body, type = 'application/json') => {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  try {
    const route = new URL(request.url, 'http://127.0.0.1:8052').pathname;
    if (request.method === 'GET') {
      if (route === '/') return reply(200, fs.readFileSync(new URL('login.html', import.meta.url)), 'text/html; charset=utf-8');
      if (route === '/app.js') return reply(200, fs.readFileSync(new URL('login-ui.js', import.meta.url)), 'text/javascript');
      if (route === '/status') return reply(200, { ...browser.status, ...await form.inspect() });
      if (route === '/frame') {
        const frame = await browser.frame();
        return reply(frame ? 200 : 204, frame || '', 'image/jpeg');
      }
    }
    if (request.method !== 'POST') return reply(404, { error: 'not_found' });
    let size = 0, chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8192) return reply(413, { error: 'too_large' });
      chunks.push(chunk);
    }
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    chunks = [];
    if (['/credentials', '/factor', '/code'].includes(route)) {
      if (form.busy) return reply(409, { error: 'busy' });
      const action = route === '/credentials' ? form.credentials(data)
        : route === '/factor' ? form.factor(data.kind) : form.code(data);
      void action.catch(() => { browser.status.state = 'login_failed'; });
      return reply(202, { ok: true });
    }
    if (route === '/start') {
      if (data.restart === true) await browser.stop();
      void browser.start();
      return reply(202, { ok: true });
    }
    if (route === '/stop') {
      await browser.stop();
      return reply(200, { ok: true });
    }
    if (route === '/input') {
      const handled = await browser.input(data);
      return reply(handled ? 200 : 409, handled ? { ok: true } : { error: 'login_window_not_ready' });
    }
    reply(404, { error: 'not_found' });
  } catch { reply(503, { error: 'browser_unavailable' }); }
});
server.requestTimeout = 15000;
server.listen(8052, '127.0.0.1', () => console.log('Thinkorswim login bridge ready on loopback.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  server.close();
  await browser.stop();
  server.closeAllConnections();
  process.exit(0);
});
