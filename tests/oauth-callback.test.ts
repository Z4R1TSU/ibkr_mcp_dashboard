import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { Vault } from '../server/vault.js';
import { IbkrClient, IbkrOAuth } from '../server/ibkr.js';
import type { Collector } from '../server/collector.js';

async function fixture(publicUrl = 'http://127.0.0.1:18048') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-callback-test-'));
  const vault = new Vault(directory);
  vault.setPassword('test-dashboard-password');
  const oauth = new IbkrOAuth(vault);
  const record = { exchanges: 0, starts: 0, pauses: 0, failExchange: false };
  oauth.begin = async () => {
    const url = new URL('https://api.ibkr.com/oauth2/authorize');
    url.searchParams.set('state', oauth.state());
    url.searchParams.set('scope', 'mcp.read');
    url.searchParams.set('redirect_uri', publicUrl + '/auth/ibkr/callback');
    return url.href;
  };
  oauth.complete = async (code, state) => {
    record.exchanges++;
    assert.equal(code, 'fixture-authorization-code');
    assert.equal(state, vault.get().oauth?.state);
    if (record.failExchange) throw new Error('fixture-token-exchange-error');
    oauth.saveTokens({ access_token: 'fixture-access-token', token_type: 'Bearer', scope: 'mcp.read' });
  };
  const client = new IbkrClient(oauth);
  const collector = Object.assign(new EventEmitter(), {
    view: () => ({ snapshot: null, status: { connected: Boolean(vault.get().oauth?.tokens) } }),
    pause: async () => { record.pauses++; }, start: () => { record.starts++; },
  }) as unknown as Collector;
  const app = () => createApp(client, collector, { ...config, accessMode: 'password', publicUrl });
  const server = app().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const request = (route: string, options: RequestInit = {}) => fetch(base + route, { ...options, redirect: 'manual' });
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', headers: { Origin: publicUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-dashboard-password' }) });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: (await response.json() as { csrf: string }).csrf };
  };
  const begin = async (session: { cookie: string; csrf: string }) => {
    const response = await request('/api/ibkr/connect', { method: 'POST', headers: { Origin: publicUrl, Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    return new URL((await response.json() as { url: string }).url);
  };
  const callback = (url: URL) => '/auth/ibkr/callback?code=fixture-authorization-code&state=' + url.searchParams.get('state');
  const clean = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true });
  };
  return { publicUrl, vault, record, server, app, request, login, begin, callback, clean };
}

test('IB callback returns to the dashboard, resumes collection, and rejects replay without logging credentials', async t => {
  const log = t.mock.method(console, 'info', () => {});
  const f = await fixture();
  try {
    const session = await f.login();
    const url = await f.begin(session);
    assert.equal(url.searchParams.get('redirect_uri'), f.publicUrl + '/auth/ibkr/callback');
    const response = await f.request(f.callback(url), { headers: { Cookie: session.cookie, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/?connection=success');
    assert.ok(f.vault.get().oauth?.tokens?.access_token);
    assert.equal(f.record.exchanges, 1);
    assert.equal(f.record.starts, 2);
    assert.equal(f.record.pauses, 2);
    const replay = await f.request(f.callback(url), { headers: { Cookie: session.cookie } });
    assert.equal(replay.headers.get('location'), '/?connection=invalid-state');
    assert.equal(f.record.exchanges, 1);
    const logged = log.mock.calls.map(call => call.arguments.join(' ')).join('\n');
    assert.match(logged, /callback_received/);
    assert.match(logged, /success/);
    assert.doesNotMatch(logged, /fixture-authorization-code|fixture-access-token|test-dashboard-password/);
    assert.equal(logged.includes(url.searchParams.get('state')!), false);
  } finally { await f.clean(); }
});

test('dashboard cookies from different ports coexist during the IB round trip', async t => {
  t.mock.method(console, 'info', () => {});
  const first = await fixture();
  const second = await fixture('http://127.0.0.1:28048');
  try {
    const one = await first.login(), two = await second.login();
    assert.notEqual(one.cookie.split('=')[0], two.cookie.split('=')[0]);
    const url = await first.begin(one);
    const cookies = 'ibkr_session=legacy-mac-cookie; ' + two.cookie + '; ' + one.cookie;
    const response = await first.request(first.callback(url), { headers: { Cookie: cookies } });
    assert.equal(response.headers.get('location'), '/?connection=success');
    assert.equal(first.record.exchanges, 1);
    assert.equal(second.record.exchanges, 0);
  } finally { await first.clean(); await second.clean(); }
});

test('missing, unrelated and restarted sessions return to the dashboard without exchanging the code', async t => {
  t.mock.method(console, 'info', () => {});
  const f = await fixture();
  try {
    const owner = await f.login(), unrelated = await f.login();
    const url = await f.begin(owner);
    const missing = await f.request(f.callback(url));
    assert.equal(missing.status, 303);
    assert.equal(missing.headers.get('location'), '/?connection=session-expired');
    const wrong = await f.request(f.callback(url), { headers: { Cookie: unrelated.cookie } });
    assert.equal(wrong.headers.get('location'), '/?connection=invalid-state');
    const forged = await f.request('/auth/ibkr/callback?code=fixture-authorization-code&state=wrong', { headers: { Cookie: owner.cookie } });
    assert.equal(forged.headers.get('location'), '/?connection=invalid-state');
    f.server.removeAllListeners('request');
    f.server.on('request', f.app());
    const restarted = await f.request(f.callback(url), { headers: { Cookie: owner.cookie } });
    assert.equal(restarted.headers.get('location'), '/?connection=session-expired');
    assert.equal(f.record.exchanges, 0);
    assert.equal(f.vault.get().oauth?.tokens, undefined);
  } finally { await f.clean(); }
});

test('IB refusal and token exchange errors return actionable outcomes without claiming success', async t => {
  t.mock.method(console, 'info', () => {});
  const f = await fixture();
  try {
    const session = await f.login();
    let url = await f.begin(session);
    const denied = await f.request('/auth/ibkr/callback?state=' + url.searchParams.get('state') + '&error=access_denied&error_description=untrusted', { headers: { Cookie: session.cookie } });
    assert.equal(denied.headers.get('location'), '/?connection=access-denied');
    assert.equal(f.record.exchanges, 0);
    url = await f.begin(session);
    f.record.failExchange = true;
    const failed = await f.request(f.callback(url), { headers: { Cookie: session.cookie } });
    assert.equal(failed.headers.get('location'), '/?connection=token-exchange-failed');
    assert.equal(f.record.exchanges, 1);
    assert.equal(f.vault.get().oauth?.tokens, undefined);
    assert.equal(f.record.starts, 3);
    assert.doesNotMatch(await failed.text(), /fixture-token-exchange-error|fixture-authorization-code/);
  } finally { await f.clean(); }
});
