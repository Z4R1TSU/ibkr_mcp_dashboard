import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Socket, type AddressInfo } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { modelFetch } from '../server/bot/model-fetch.js';
import { errorCode } from '../server/bot/request-errors.js';

test('model connections allow slow TLS while preserving validation and cancellation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-connect-'));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=localhost'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const tls = createTlsServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(socket => {
    sockets.add(socket);
    const timer = setTimeout(() => { timers.delete(timer); tls.emit('connection', socket); }, 11000);
    timers.add(timer);
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); clearTimeout(timer); timers.delete(timer); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = 'https://127.0.0.1:' + (server.address() as AddressInfo).port;
  try {
    // Reaching certificate validation proves the slow handshake survived the old
    // native-fetch connection limit. The test certificate is deliberately untrusted.
    await assert.rejects(modelFetch(url, { signal: AbortSignal.timeout(20000) }),
      error => errorCode(error) === 'DEPTH_ZERO_SELF_SIGNED_CERT');
    await assert.rejects(modelFetch(url, { signal: AbortSignal.timeout(50) }),
      error => error instanceof Error && error.name === 'TimeoutError');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
