import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { dashboardAddress, createDashboardRequest, connectionError } from '../scripts/discord-http.mjs';

test('remote sync supports intranet configuration while rejecting local mode', () => {
  for (const accessMode of ['intranet', 'password', 'local']) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      'await import("./server/config.ts");'], {
      encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/dev/null', ACCESS_MODE: accessMode,
        DISCORD_TRANSPORT: 'remote', HOST: '127.0.0.1', PORT: '8048', PUBLIC_URL: 'https://10.0.0.1:8443',
        INTRANET_HTTPS_CERT_FILE: '/tmp/fixture.crt', INTRANET_HTTPS_KEY_FILE: '/tmp/fixture.key' },
    });
    assert.equal(child.status, accessMode === 'local' ? 1 : 0, child.stderr);
  }
});

test('sync accepts HTTPS or loopback HTTP and rejects credential-bearing or redirected URLs', () => {
  for (const url of ['https://10.0.0.1:8443', 'http://127.0.0.1:8048']) assert.ok(dashboardAddress(url));
  for (const url of ['http://10.0.0.1', 'https://user:secret@example.com', 'https://example.com/?token=secret', 'https://example.com/path']) {
    assert.throws(() => dashboardAddress(url));
  }
});

test('sync verifies the bundled certificate, preserves bearer auth, and rejects redirects and oversized data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-https-'));
  const certFile = path.join(directory, 'server.crt'), keyFile = path.join(directory, 'server.key');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-days', '2', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=Discord sync test',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:FALSE'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const env = { DISCORD_SYNC_TOKEN: 'a'.repeat(64) };
  let status = 200, oversized = false, requests = 0;
  const server = createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'Bearer ' + env.DISCORD_SYNC_TOKEN);
    res.writeHead(status, { 'Content-Type': 'application/json', Location: '/redirected' });
    res.end(oversized ? 'x'.repeat(65537) : JSON.stringify({ version: 1 }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = new URL('https://127.0.0.1:' + (server.address() as AddressInfo).port);
  try {
    const untrusted = createDashboardRequest(address, env, directory);
    await assert.rejects(untrusted('/api/discord/remote'), error => {
      assert.match(connectionError(error), /证书校验失败/);
      return true;
    });
    assert.equal(requests, 0);
    const trusted = createDashboardRequest(address, { ...env, DASHBOARD_CA_FILE: 'server.crt' }, directory);
    assert.deepEqual(await trusted('/api/discord/remote'), { version: 1 });
    assert.deepEqual(await trusted('/api/discord/remote/status', { connected: false }), { version: 1 });
    assert.equal(requests, 2);
    status = 302;
    await assert.rejects(trusted('/api/discord/remote'), /HTTP 302/);
    assert.equal(requests, 3);
    status = 200; oversized = true;
    await assert.rejects(trusted('/api/discord/remote'), /大小限制/);
    await assert.rejects(trusted('/api/portfolio'), /不支持/);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(createDashboardRequest(address, { ...env, DASHBOARD_CA_FILE: certFile }, directory, aborted.signal)('/api/discord/remote'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
