import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, request as requestHttp, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { createAccessPolicy, isDirectLocalRequest, type AccessSettings } from '../server/access.js';
import { createApp } from '../server/app.js';
import { Vault } from '../server/vault.js';
import { IbkrClient, IbkrOAuth } from '../server/ibkr.js';
import type { Collector } from '../server/collector.js';
import { createDiscord } from '../server/discord/index.js';
import { PresenceData } from '../server/discord/data.js';

const settings: AccessSettings = { accessMode: 'local', host: '127.0.0.1', port: 8048, publicUrl: 'http://127.0.0.1:8048' };

test('Discord endpoints preserve session and CSRF boundaries', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-discord-http-'));
  const collector = { view: () => ({ snapshot: null, status: { connected: false } }) } as Collector;
  const client = new IbkrClient(new IbkrOAuth(new Vault(directory)));
  const discord = createDiscord(directory, new PresenceData(() => collector.view(), async () => ({}), async () => '2026-09-28'));
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = 'http://127.0.0.1:' + port;
  server.on('request', createApp(client, collector, { ...settings, port, publicUrl: base }, undefined, undefined, discord.controls));
  try {
    assert.equal((await fetch(base + '/api/discord')).status, 200);
    assert.equal((await fetch(base + '/api/discord/summary')).status, 200);
    const bootstrap = await fetch(base + '/api/session');
    const session = await bootstrap.json() as { csrf: string };
    const headers = { Origin: base, Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0], 'Content-Type': 'application/json' };
    const body = JSON.stringify({ enabled: false, applicationId: '123456789012345678', startDate: '2026-03-31' });
    assert.equal((await fetch(base + '/api/discord', { method: 'POST', headers, body })).status, 403);
    const authorized = { ...headers, 'X-CSRF-Token': session.csrf };
    assert.equal((await fetch(base + '/api/discord', { method: 'POST', headers: authorized, body })).status, 200);
    assert.equal(discord.controls.status().settings.startDate, '2026-03-31');
    assert.equal((await fetch(base + '/api/discord/preview', { method: 'POST', headers, body: '{}' })).status, 403);
    server.removeAllListeners('request');
    server.on('request', createApp(client, collector, { ...settings, accessMode: 'password', publicUrl: 'https://portfolio.example.com' }, undefined, undefined, discord.controls));
    assert.equal((await fetch(base + '/api/discord')).status, 401);
    assert.equal((await fetch(base + '/api/discord/summary')).status, 401);
  } finally {
    await discord.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true });
  }
});

function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(url, { headers }, response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('password-free configuration refuses public binding, public URLs, and mismatched ports', () => {
  assert.equal(createAccessPolicy(settings).localAccess, true);
  assert.throws(() => createAccessPolicy({ ...settings, host: '0.0.0.0' }));
  assert.throws(() => createAccessPolicy({ ...settings, host: '::' }));
  assert.throws(() => createAccessPolicy({ ...settings, publicUrl: 'https://portfolio.example.com' }));
  assert.throws(() => createAccessPolicy({ ...settings, publicUrl: 'http://127.0.0.1:9999' }));
  const publicPolicy = createAccessPolicy({ ...settings, accessMode: 'password', host: '0.0.0.0', publicUrl: 'https://portfolio.example.com' });
  assert.equal(publicPolicy.localAccess, false);
  assert.deepEqual([...publicPolicy.origins], ['https://portfolio.example.com']);
});

test('local access checks network peer, Host, Origin, proxy headers, and browser fetch metadata', () => {
  const policy = createAccessPolicy(settings);
  const request = { remoteAddress: '127.0.0.1', host: '127.0.0.1:8048', apiRequest: true, forwarded: false };
  assert.equal(isDirectLocalRequest(policy, request), true);
  assert.equal(isDirectLocalRequest(policy, { ...request, host: 'localhost:8048', origin: 'http://localhost:8048', fetchSite: 'same-origin' }), true);
  assert.equal(isDirectLocalRequest(policy, { ...request, remoteAddress: '::1', host: '[::1]:8048' }), true);
  for (const change of [
    { remoteAddress: '192.168.1.5' }, { remoteAddress: '203.0.113.10' }, { remoteAddress: undefined },
    { host: 'attacker.invalid:8048' }, { host: 'localhost.evil.invalid:8048' }, { host: '127.0.0.1:9000' },
    { origin: 'null' }, { origin: 'https://attacker.invalid' }, { origin: 'http://localhost:9000' },
    { fetchSite: 'cross-site' }, { fetchSite: 'same-site' }, { forwarded: true },
  ]) assert.equal(isDirectLocalRequest(policy, { ...request, ...change }), false, JSON.stringify(change));
  assert.equal(isDirectLocalRequest(policy, { ...request, apiRequest: false, fetchSite: 'cross-site' }), true);
});

test('local mode enters without a password, maintains CSRF, and silently re-establishes a restarted session', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-local-test-'));
  const vault = new Vault(directory);
  let refreshes = 0;
  const collector = Object.assign(new EventEmitter(), { view: () => ({ snapshot: null, status: { connected: false } }), refresh: async () => { refreshes += 1; } }) as unknown as Collector;
  const client = new IbkrClient(new IbkrOAuth(vault));
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const localSettings: AccessSettings = { ...settings, port, publicUrl: base };
  server.on('request', createApp(client, collector, localSettings));
  try {
    assert.equal(vault.get().admin, undefined);
    const bootstrap = await fetch(`${base}/api/session`);
    const session = await bootstrap.json() as { authenticated: boolean; csrf: string; accessMode: string };
    assert.equal(session.authenticated, true);
    assert.equal(session.accessMode, 'local');
    assert.ok(session.csrf);
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    assert.match(bootstrap.headers.get('set-cookie')!, /HttpOnly/);
    assert.equal((await fetch(`${base}/api/portfolio`)).status, 200);
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: base, Cookie: cookie } })).status, 403);
    assert.equal(refreshes, 0);
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'X-CSRF-Token': session.csrf } })).status, 202);
    assert.equal(refreshes, 1);
    for (const endpoint of ['login', 'logout', 'password']) assert.equal((await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'X-CSRF-Token': session.csrf } })).status, 404);
    const alias = await rawGet(base, { Host: `localhost:${port}` });
    assert.equal(alias.status, 302);
    assert.equal(alias.headers.location, base + '/');
    const aliasSession = await rawGet(`${base}/api/session`, { Host: `localhost:${port}`, Origin: `http://localhost:${port}` });
    assert.equal(aliasSession.status, 200);
    for (const headers of [
      { Origin: 'https://attacker.invalid' }, { Origin: 'null' }, { Host: `attacker.invalid:${port}` },
      { 'X-Forwarded-For': '203.0.113.10' }, { 'X-Forwarded-Host': 'portfolio.example.com' },
      { Forwarded: 'for=203.0.113.10' }, { 'X-Real-IP': '203.0.113.10' }, { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const blocked = await rawGet(`${base}/api/session`, headers as Record<string, string>);
      assert.equal(blocked.status, 403, JSON.stringify(headers));
      assert.equal(blocked.headers['set-cookie'], undefined);
    }
    server.removeAllListeners('request');
    server.on('request', createApp(client, collector, localSettings));
    const restored = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
    const nextSession = await restored.json() as { authenticated: boolean; csrf: string };
    assert.equal(nextSession.authenticated, true);
    assert.notEqual(nextSession.csrf, session.csrf);
    const nextCookie = restored.headers.get('set-cookie')!.split(';')[0];
    assert.notEqual(nextCookie, cookie);
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: base, Cookie: nextCookie, 'X-CSRF-Token': nextSession.csrf } })).status, 202);
    assert.equal(refreshes, 2);
    assert.equal(vault.get().admin, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true });
  }
});
