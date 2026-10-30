import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RemoteDiscord } from '../server/discord/remote.js';
import { createDiscord } from '../server/discord/index.js';
import { PresenceData } from '../server/discord/data.js';
import { createApp } from '../server/app.js';
import { Vault } from '../server/vault.js';
import { IbkrClient, IbkrOAuth } from '../server/ibkr.js';
import type { Collector } from '../server/collector.js';

test('remote Discord token persists privately and stale heartbeats cannot stay connected', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-remote-'));
  try {
    const remote = new RemoteDiscord(directory);
    const file = path.join(directory, 'discord-sync-token');
    const header = 'Bearer ' + fs.readFileSync(file, 'utf8').trim();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(remote.authorized(undefined), false);
    assert.equal(remote.authorized(header + 'x'), false);
    assert.equal(remote.authorized(header), true);
    assert.equal(new RemoteDiscord(directory).authorized(header), true);
    assert.throws(() => remote.report({ connected: 'true' }));
    const now = Date.now();
    remote.report({ connected: true, lastSentAt: new Date(now).toISOString(), error: null }, now);
    assert.equal(remote.status(now + 1000).connected, true);
    assert.equal(remote.status(now + 90001).connected, false);
    remote.reset();
    assert.equal(remote.status(now).connected, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('remote bearer accesses only Discord summary and heartbeat, without dashboard session privileges', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-remote-http-'));
  const collector = { view: () => ({ snapshot: null, status: { connected: false, stale: true } }) } as Collector;
  const client = new IbkrClient(new IbkrOAuth(new Vault(directory)));
  const discord = createDiscord(directory, new PresenceData(() => collector.view(), async () => ({}), async () => '2026-09-30'), undefined, { remote: true });
  await discord.controls.update({ enabled: true, applicationId: '1554402993036726372', startDate: '2026-03-31' });
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  server.on('request', createApp(client, collector, { accessMode: 'password', host: '127.0.0.1', port, publicUrl: base }, undefined, undefined, discord.controls));
  const token = fs.readFileSync(path.join(directory, 'discord-sync-token'), 'utf8').trim();
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/api/discord/remote')).status, 401);
    assert.equal((await fetch(base + '/api/discord/remote', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const response = await fetch(base + '/api/discord/remote', { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.settings.applicationId, '1554402993036726372');
    assert.equal(body.summary.version, 1);
    assert.equal(JSON.stringify(body).includes(token), false);
    assert.equal((await fetch(base + '/api/portfolio', { headers })).status, 401);
    assert.equal((await fetch(base + '/api/discord', { headers })).status, 401);
    const report = { connected: true, lastSentAt: new Date().toISOString(), error: null };
    assert.equal((await fetch(base + '/api/discord/remote/status', { method: 'POST', headers, body: JSON.stringify(report) })).status, 200);
    assert.equal(discord.controls.status().connected, true);
    assert.equal(discord.controls.status().transport, 'remote');
    assert.equal((await fetch(base + '/api/discord/remote/status', { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(base + '/api/discord/remote/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) })).status, 403);
    assert.equal((await fetch(base + '/api/refresh', { method: 'POST', headers: { ...headers, Origin: base }, body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/api/discord', { method: 'POST', headers: { ...headers, Origin: base }, body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/api/discord/remote/status/extra', { method: 'POST', headers, body: '{}' })).status, 401);
  } finally {
    await discord.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
