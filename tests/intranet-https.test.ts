import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { request } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { intranetHttpsSettings, startIntranetHttps } from '../server/intranet-https.js';
import { createApp } from '../server/app.js';
import { createDiscord } from '../server/discord/index.js';
import { PresenceData } from '../server/discord/data.js';
import { config } from '../server/config.js';
import { Vault } from '../server/vault.js';
import { IbkrClient, IbkrOAuth } from '../server/ibkr.js';
import type { Collector } from '../server/collector.js';
import { createAccessPolicy, isIntranetPeer, isTrustedIntranetRequest } from '../server/access.js';

test('intranet TLS requires a private IP and separate loopback backend', () => {
  const app = { accessMode: 'password', host: '127.0.0.1', port: 8048, publicUrl: 'https://10.37.22.84:8443' };
  const env = { INTRANET_HTTPS_CERT_FILE: 'cert.crt', INTRANET_HTTPS_KEY_FILE: 'server.key' };
  assert.equal(intranetHttpsSettings({}, app), undefined);
  assert.throws(() => intranetHttpsSettings({ INTRANET_HTTPS_CERT_FILE: 'cert' }, app));
  assert.equal(intranetHttpsSettings(env, app)?.hostname, '10.37.22.84');
  for (const change of [
    { accessMode: 'local' }, { host: '0.0.0.0' }, { publicUrl: 'http://10.37.22.84:8443' },
    { publicUrl: 'https://8.8.8.8:8443' }, { publicUrl: 'https://169.254.169.254:8443' },
    { publicUrl: 'https://example.com:8443' }, { publicUrl: 'https://10.37.22.84:8048' },
  ]) assert.throws(() => intranetHttpsSettings(env, { ...app, ...change }));
  assert.throws(() => intranetHttpsSettings({ ...env, INTRANET_CERT_PORT: '8443' }, app));
  const passwordless = { ...app, accessMode: 'intranet' as const, intranetGatewayToken: 'test-gateway-token' };
  assert.equal(intranetHttpsSettings(env, passwordless)?.gatewayToken, 'test-gateway-token');
  assert.throws(() => intranetHttpsSettings({}, passwordless));
  const policy = createAccessPolicy(passwordless);
  const peer = { remoteAddress: '127.0.0.1', host: '10.37.22.84:8443', gatewayToken: 'test-gateway-token', apiRequest: true, forwarded: false };
  assert.equal(isTrustedIntranetRequest(policy, peer), true);
  for (const invalid of [{ gatewayToken: '' }, { gatewayToken: 'fake' }, { remoteAddress: '10.0.0.2' },
    { origin: 'https://foreign.example' }, { forwarded: true }, { fetchSite: 'cross-site' }]) {
    assert.equal(isTrustedIntranetRequest(policy, { ...peer, ...invalid }), false);
  }
  assert.equal(isIntranetPeer('::ffff:10.0.0.2'), true);
  assert.equal(isIntranetPeer('203.0.113.1'), false);
  assert.throws(() => createAccessPolicy({ ...passwordless, publicUrl: 'https://8.8.8.8:8443' }));
});

async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const value = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return value;
}

function read(url: string, ca?: Buffer, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const address = new URL(url);
    const req = request({ hostname: '127.0.0.1', port: address.port, path: address.pathname + address.search, ca,
      headers: { Host: address.host, ...headers }, method: body === undefined ? 'GET' : 'POST' }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

for (const accessMode of ['password', 'intranet'] as const) test('HTTPS access, CSRF, callbacks and live events: ' + accessMode, async t => {
  t.mock.method(console, 'info', () => {});
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-intranet-'));
  const certFile = path.join(directory, 'server.crt'), keyFile = path.join(directory, 'server.key');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-days', '2', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=IBKR Devbox 127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,IP:10.0.0.1', '-addext', 'basicConstraints=critical,CA:FALSE'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const cert = fs.readFileSync(certFile), tlsPort = await port(), certificatePort = await port();
  const publicUrl = 'https://10.0.0.1:' + tlsPort;
  const vault = new Vault(directory);
  if (accessMode === 'password') vault.setPassword('test-intranet-password');
  const collector = Object.assign(new EventEmitter(), { view: () => ({ snapshot: null, status: { connected: false } }), refresh: async () => {}, pause: async () => {}, start: () => {} }) as unknown as Collector;
  const oauth = new IbkrOAuth(vault);
  oauth.begin = async () => 'https://api.ibkr.com/oauth2/authorize?state=fixture-state';
  oauth.complete = async (code, state) => {
    assert.equal(code, 'fixture-code'); assert.equal(state, 'fixture-state');
    oauth.saveTokens({ access_token: 'fixture-access', scope: 'mcp.read', token_type: 'Bearer' });
  };
  const gatewayToken = accessMode === 'intranet' ? 'test-gateway-token' : undefined;
  const discord = createDiscord(directory, new PresenceData(() => collector.view(), async () => ({}), async () => '2026-09-30'), undefined, { remote: true });
  await discord.controls.update({ enabled: true, applicationId: '123456789012345678', startDate: '2026-03-31' });
  fs.writeFileSync(path.join(directory, 'discord-mac.tar.gz'), 'test-package');
  const syncHeaders = { Authorization: 'Bearer ' + fs.readFileSync(path.join(directory, 'discord-sync-token'), 'utf8').trim() };
  const makeApp = () => createApp(new IbkrClient(oauth), collector, { ...config, accessMode, publicUrl, intranetGatewayToken: gatewayToken }, undefined, undefined, discord.controls);
  const backend = createServer(makeApp()).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { backend.once('listening', resolve); backend.once('error', reject); });
  const gateway = await startIntranetHttps({ hostname: '127.0.0.1', port: tlsPort, certificatePort, publicUrl, certFile, keyFile,
    upstreamHost: '127.0.0.1', upstreamPort: (backend.address() as AddressInfo).port, gatewayToken });
  try {
    assert.equal((await read(publicUrl + '/api/discord/remote', cert)).status, 401);
    const summary = await read(publicUrl + '/api/discord/remote', cert, syncHeaders);
    assert.equal(summary.status, 200);
    assert.equal(summary.headers['set-cookie'], undefined);
    assert.equal(JSON.parse(summary.body).summary.version, 1);
    for (const endpoint of ['portfolio', 'session', 'discord/mac-download']) {
      assert.equal((await read(publicUrl + '/api/' + endpoint, cert, syncHeaders)).status, 401);
    }
    const heartbeat = await read(publicUrl + '/api/discord/remote/status', cert, { ...syncHeaders, 'Content-Type': 'application/json' },
      JSON.stringify({ connected: true, lastSentAt: new Date().toISOString(), error: null }));
    assert.equal(heartbeat.status, 200);
    assert.equal(discord.controls.status().connected, true);
    assert.equal((await read(publicUrl + '/api/portfolio', cert)).status, accessMode === 'intranet' ? 200 : 401);
    await assert.rejects(read(publicUrl + '/api/health'));
    await assert.rejects(read(publicUrl + '/api/health', cert, { Host: 'foreign.example' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    const login = accessMode === 'intranet' ? await read(publicUrl + '/api/session', cert)
      : await read(publicUrl + '/api/login', cert, { Origin: publicUrl, 'Content-Type': 'application/json' }, JSON.stringify({ password: 'test-intranet-password' }));
    assert.equal(login.status, 200);
    assert.match(login.headers['set-cookie']![0], /__Host-ibkr_session_.*HttpOnly.*Secure/);
    const headers = { Cookie: login.headers['set-cookie']![0].split(';')[0], Origin: publicUrl, 'Content-Type': 'application/json' };
    const download = await read(publicUrl + '/api/discord/mac-download', cert, headers);
    assert.equal(download.status, 200);
    assert.equal(download.body, 'test-package');
    assert.match(download.headers['content-disposition']!, /attachment.*discord-mac.tar.gz/);
    assert.equal(download.headers['cache-control'], 'no-store');
    assert.equal((await read(publicUrl + '/api/portfolio', cert, headers)).status, 200);
    assert.equal((await read(publicUrl + '/api/refresh', cert, headers, '{}')).status, 403);
    assert.equal((await read(publicUrl + '/api/refresh', cert, { ...headers, 'X-CSRF-Token': JSON.parse(login.body).csrf }, '{}')).status, 202);
    const callback = await read(publicUrl + '/auth/ibkr/callback?code=fixture-code&state=invalid', cert, headers);
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.location, '/?connection=invalid-state');
    await new Promise<void>((resolve, reject) => {
      const req = request('https://127.0.0.1:' + tlsPort + '/api/events', { ca: cert, headers: { ...headers, Host: new URL(publicUrl).host } }, res => {
        res.once('data', chunk => {
          try { assert.match(chunk.toString(), /^data: /); resolve(); } catch (error) { reject(error); }
          res.destroy();
        });
      });
      req.on('error', reject);
      req.end();
    });
    const bootstrap = 'http://127.0.0.1:' + certificatePort;
    const page = await fetch(bootstrap).then(r => r.text());
    assert.ok(page.includes(publicUrl));
    const downloaded = await fetch(bootstrap + '/certificate.cer').then(r => r.arrayBuffer());
    assert.equal(new X509Certificate(Buffer.from(downloaded)).fingerprint256, new X509Certificate(cert).fingerprint256);
    for (const url of ['/api/portfolio', '/api/login', '/auth/ibkr/callback', '/server.key', '/data/tls/server.key']) assert.equal((await fetch(bootstrap + url)).status, 404);
    assert.equal((await fetch(bootstrap + '/', { method: 'POST' })).status, 405);
    if (accessMode === 'intranet') {
      assert.equal(vault.get().admin, undefined);
      assert.equal(JSON.parse(login.body).accessMode, 'intranet');
      for (const endpoint of ['login', 'logout', 'password']) {
        assert.equal((await read(publicUrl + '/api/' + endpoint, cert, headers, '{}')).status, 404);
      }
      const crossSite = await read(publicUrl + '/api/session', cert, { Origin: 'https://foreign.example' });
      assert.equal(crossSite.status, 403);
      assert.equal(crossSite.headers['set-cookie'], undefined);
      const direct = await fetch('http://127.0.0.1:' + (backend.address() as AddressInfo).port + '/api/session', {
        headers: { Host: new URL(publicUrl).host, 'X-IBKR-Intranet-Gateway': 'forged' },
      });
      assert.equal(direct.status, 403);
      const directSync = await fetch('http://127.0.0.1:' + (backend.address() as AddressInfo).port + '/api/discord/remote', {
        headers: { ...syncHeaders, Host: new URL(publicUrl).host },
      });
      assert.equal(directSync.status, 403);
      const forged = await read(publicUrl + '/api/session', cert, { 'X-IBKR-Intranet-Gateway': 'forged', 'X-Forwarded-For': '203.0.113.1' });
      assert.equal(forged.status, 200);
      assert.equal(forged.body.includes('test-gateway-token'), false);
      backend.removeAllListeners('request');
      backend.on('request', makeApp());
      const restored = await read(publicUrl + '/api/session', cert, headers);
      assert.equal(JSON.parse(restored.body).authenticated, true);
      assert.notEqual(JSON.parse(restored.body).csrf, JSON.parse(login.body).csrf);
      const restoredCookie = restored.headers['set-cookie']![0].split(';')[0];
      const connected = await read(publicUrl + '/api/ibkr/connect', cert, {
        Origin: publicUrl, Cookie: restoredCookie, 'X-CSRF-Token': JSON.parse(restored.body).csrf, 'Content-Type': 'application/json',
      }, '{}');
      assert.equal(connected.status, 200);
      const completed = await read(publicUrl + '/auth/ibkr/callback?code=fixture-code&state=fixture-state', cert, { Cookie: restoredCookie, 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(completed.headers.location, '/?connection=success');
      assert.equal(vault.get().oauth?.tokens?.access_token, 'fixture-access');
    }
  } finally {
    await discord.stop();
    await gateway.close();
    backend.closeAllConnections();
    await new Promise<void>(resolve => backend.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
