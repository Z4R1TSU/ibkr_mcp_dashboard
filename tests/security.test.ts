import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Vault } from '../server/vault.js';
import { IbkrClient, IbkrOAuth, validateReadScope, decodeToolResult } from '../server/ibkr.js';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import type { Collector } from '../server/collector.js';
import type { AddressInfo } from 'node:net';

test('encrypted vault persists secrets without plaintext and validates passwords', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-vault-test-'));
  try {
    const vault = new Vault(directory);
    vault.setPassword('a-long-testing-password');
    vault.update(value => { value.oauth = { tokens: { access_token: 'SECRET-FIXTURE-NOT-REAL', token_type: 'Bearer', scope: 'mcp.read' } }; });
    assert.equal(fs.readFileSync(path.join(directory, 'vault.enc'), 'utf8').includes('SECRET-FIXTURE-NOT-REAL'), false);
    assert.equal(new Vault(directory).checkPassword('a-long-testing-password'), true);
    assert.equal(vault.checkPassword('incorrect'), false);
    assert.equal(fs.statSync(path.join(directory, 'vault.enc')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
test('write scopes and unlisted tools fail before network activity', async () => {
  assert.throws(() => validateReadScope('mcp.read mcp.write'));
  assert.throws(() => validateReadScope(undefined));
  validateReadScope('mcp.read');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-scope-test-'));
  try {
    const oauth = new IbkrOAuth(new Vault(directory));
    assert.throws(() => oauth.redirectToAuthorization(new URL('https://api.ibkr.com/oauth2/authorize?scope=mcp.write')));
    assert.throws(() => oauth.redirectToAuthorization(new URL('https://example.com/?scope=mcp.read')));
    const client = new IbkrClient(oauth);
    await assert.rejects(client.call('submit_order'));
    await assert.rejects(client.call('create_order_instruction'));
    assert.throws(() => decodeToolResult({ isError: true, content: [] }));
  } finally { fs.rmSync(directory, { recursive: true }); }
});
test('HTTP authentication, CSRF, session revocation, and credential isolation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-http-test-'));
  const vault = new Vault(directory);
  vault.setPassword('a-long-testing-password');
  let refreshes = 0;
  const collector = Object.assign(new EventEmitter(), { view: () => ({ snapshot: null, status: { connected: false } }), refresh: async () => { refreshes += 1; } }) as unknown as Collector;
  const client = new IbkrClient(new IbkrOAuth(vault));
  let groupUpdates = 0;
  const controls = { groups: () => { groupUpdates++; }, chats: async () => [], members: async () => ({ members: [] }) };
  const server = createApp(client, collector, { ...config, accessMode: 'password' }, () => ({ enabled: true }), controls).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = new URL(config.publicUrl).origin;
  try {
    assert.equal((await fetch(base + '/api/integrations')).status, 401);
    assert.equal((await fetch(`${base}/api/portfolio`)).status, 401);
    assert.equal((await fetch(`${base}/api/events`)).status, 401);
    const health = await fetch(`${base}/api/health`);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    const foreignLogin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' }, body: JSON.stringify({ password: 'a-long-testing-password' }) });
    assert.equal(foreignLogin.status, 403);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'a-long-testing-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(login.headers.get('set-cookie')!, /SameSite=Lax/);
    const session = await login.json() as { csrf: string };
    const groupsUrl = base + '/api/integrations/groups';
    const groupBody = JSON.stringify({ groups: [] });
    const groupHeaders = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
    assert.equal((await fetch(groupsUrl, { method: 'POST', headers: groupHeaders, body: groupBody })).status, 403);
    assert.equal(groupUpdates, 0);
    assert.equal((await fetch(groupsUrl, { method: 'POST', headers: { ...groupHeaders, 'X-CSRF-Token': session.csrf }, body: groupBody })).status, 200);
    assert.equal(groupUpdates, 1);
    const noCsrf = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    assert.equal(noCsrf.status, 403);
    assert.equal(refreshes, 0);
    const refresh = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': session.csrf } });
    assert.equal(refresh.status, 202);
    assert.equal(refreshes, 1);
    const portfolio = await fetch(`${base}/api/portfolio`, { headers: { Cookie: cookie } });
    assert.equal(portfolio.status, 200);
    assert.doesNotMatch(await portfolio.text(), /access_token|refresh_token|client_secret|a-long-testing-password/);
    const callback = await fetch(`${base}/auth/ibkr/callback?code=fake&state=fake`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(callback.headers.get('location'), '/?connection=invalid-state');
    const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': session.csrf } });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${base}/api/portfolio`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true });
  }
});
