import test from 'node:test';
import assert from 'node:assert/strict';
import { restrictedFetch, exchangeToken, readFailureReason, IbkrResponseLostError } from '../server/ibkr-fetch.js';

const failure = (code: string) => new TypeError('private-fixture-error', { cause: { code } });
test('token route overrides apply before sending and connect failures retry on that same route', async t => {
  const { Agent, ProxyAgent } = await import('undici');
  t.mock.method(console, 'info', () => {});
  const previous = process.env.IBKR_TOKEN_HTTP_PROXY;
  const connections: any[] = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    connections.push((init as any).dispatcher);
    if (!calls++) throw failure('UND_ERR_CONNECT_TIMEOUT');
    return Response.json({ fixture: true });
  });
  try {
    process.env.IBKR_TOKEN_HTTP_PROXY = '';
    await exchangeToken('https://api.ibkr.com/oauth2/token', { method: 'POST' });
    assert.equal(connections.length, 2);
    assert.equal(connections[0], connections[1]);
    assert.ok(connections[0] instanceof Agent);
    process.env.IBKR_TOKEN_HTTP_PROXY = 'http://127.0.0.1:8118';
    await exchangeToken('https://api.ibkr.com/oauth2/token', { method: 'POST' });
    assert.ok(connections[2] instanceof ProxyAgent);
  } finally {
    if (previous === undefined) delete process.env.IBKR_TOKEN_HTTP_PROXY;
    else process.env.IBKR_TOKEN_HTTP_PROXY = previous;
  }
});

test('a lost response before headers is uncertain, never replayed, and logged without the grant', async t => {
  const logs = t.mock.method(console, 'info', () => {});
  let calls = 0, connection: any;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; connection = (init as any).dispatcher;
    throw failure('UND_ERR_SOCKET');
  });
  await assert.rejects(exchangeToken('https://api.ibkr.com/oauth2/token', { method: 'POST', body: 'private-grant' }), error => {
    assert.ok(error instanceof IbkrResponseLostError);
    assert.equal(error.status, null);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(connection.destroyed, true);
  const log = JSON.parse(logs.mock.calls[0].arguments[0]);
  assert.equal(log.phase, 'headers');
  assert.equal(log.status, null);
  assert.equal(log.receivedBytes, 0);
  assert.doesNotMatch(JSON.stringify(logs.mock.calls), /private-grant|private-fixture-error/);
});

test('partial token bodies record byte counts without exposing their content', async t => {
  const logs = t.mock.method(console, 'info', () => {});
  let pulls = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      if (pulls++) controller.error(new Error('private-body-error'));
      else controller.enqueue(new TextEncoder().encode('private-partial-token'));
    },
  }), { status: 200 }));
  await assert.rejects(exchangeToken('https://api.ibkr.com/oauth2/token', { method: 'POST' }), IbkrResponseLostError);
  const log = JSON.parse(logs.mock.calls[0].arguments[0]);
  assert.equal(log.phase, 'body');
  assert.equal(log.status, 200);
  assert.equal(log.receivedBytes, Buffer.byteLength('private-partial-token'));
  assert.doesNotMatch(JSON.stringify(logs.mock.calls), /private-partial-token|private-body-error/);
});

test('each token exchange owns a fresh connection and closes it after the entire body arrives', async t => {
  t.mock.method(console, 'info', () => {});
  const connections: any[] = [];
  const slow = slowBody('{"access_token":"fixture"}');
  t.mock.method(globalThis, 'fetch', (url, init) => {
    connections.push((init as any).dispatcher);
    return slow.fetchMock(url, init);
  });
  const pending = exchangeToken('https://api.ibkr.com/oauth2/token', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections[0].destroyed, false);
  slow.release();
  assert.deepEqual(await (await pending).json(), { access_token: 'fixture' });
  assert.equal(connections[0].destroyed, true);
  await exchangeToken('https://api.ibkr.com/oauth2/token', { method: 'POST' });
  assert.equal(connections[1].destroyed, true);
  const read = await restrictedFetch('https://api.ibkr.com/v1/api/mcp-public');
  await read.text();
  assert.equal(new Set(connections).size, 3);
  assert.equal(connections[2].destroyed, false);
});

test('IB connection retries share one deadline and never log credentials', async t => {
  let calls = 0;
  const signals: AbortSignal[] = [];
  const logs = t.mock.method(console, 'info', () => {});
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; signals.push(init!.signal!);
    assert.equal(init?.redirect, 'error');
    assert.ok((init as any).dispatcher);
    if (calls === 1) throw failure('UND_ERR_CONNECT_TIMEOUT');
    return Response.json({ ok: true });
  });
  const response = await restrictedFetch('https://api.ibkr.com/oauth2/token', { method: 'POST', body: 'private-token-body' });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(signals[0], signals[1]);
  assert.doesNotMatch(JSON.stringify(logs.mock.calls), /private-token-body|private-fixture-error/);
});

test('lost responses, aborted requests and foreign origins are not retried', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw failure('UND_ERR_SOCKET'); });
  await assert.rejects(restrictedFetch('https://api.ibkr.com/oauth2/token', { method: 'POST', body: 'fixture' }));
  assert.equal(calls, 1);
  await assert.rejects(restrictedFetch('https://api.ibkr.com/v1/api/mcp-public', { signal: AbortSignal.abort() }));
  await assert.rejects(restrictedFetch('https://example.com/'));
  assert.equal(calls, 1);
});

test('retry count is bounded, and HTTP failures are left to the caller', async t => {
  t.mock.method(console, 'info', () => {});
  let calls = 0, networkError = true;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (networkError) throw failure('UND_ERR_CONNECT_TIMEOUT');
    return new Response('', { status: 503 });
  });
  await assert.rejects(restrictedFetch('https://api.ibkr.com/v1/api/mcp-public'));
  assert.equal(calls, 2);
  networkError = false;
  assert.equal((await restrictedFetch('https://api.ibkr.com/oauth2/token', { method: 'POST' })).status, 503);
  assert.equal(calls, 3);
});

test('multi-address TCP timeouts are retried but uncertain aggregate errors are not', async t => {
  t.mock.method(console, 'info', () => {});
  let calls = 0, mixed = false;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    const errors = mixed ? [{ code: 'ETIMEDOUT', syscall: 'read' }] : [
      { code: 'ETIMEDOUT', syscall: 'connect' }, { code: 'ETIMEDOUT', syscall: 'connect' },
    ];
    throw new TypeError('fixture', { cause: new AggregateError(errors) });
  });
  await assert.rejects(restrictedFetch('https://api.ibkr.com/oauth2/token', { method: 'POST', body: 'fixture' }));
  assert.equal(calls, 2);
  mixed = true;
  await assert.rejects(restrictedFetch('https://api.ibkr.com/oauth2/token', { method: 'POST', body: 'fixture' }));
  assert.equal(calls, 3);
});

test('IB proxy configuration is explicit and rejects invalid schemes without exposing secrets', async () => {
  const { ibkrDispatcher } = await import('../server/ibkr-fetch.js');
  const { Agent, ProxyAgent } = await import('undici');
  const direct = ibkrDispatcher(), proxied = ibkrDispatcher('http://127.0.0.1:8118');
  assert.ok(direct instanceof Agent);
  assert.ok(proxied instanceof ProxyAgent);
  assert.throws(() => ibkrDispatcher('socks5://private-fixture:password@localhost'), error => error instanceof Error && !error.message.includes('password'));
  await direct.close(); await proxied.close();
});

// Headers arrive at once; the body is released by `release` (or never).
function slowBody(body: string) {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const fetchMock = async (_url: unknown, init?: RequestInit) => {
    const signal = init!.signal!;
    return new Response(new ReadableStream({
      async pull(controller) {
        await Promise.race([released, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
        controller.enqueue(new TextEncoder().encode(body)); controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchMock, release };
}

test('a sent token exchange is not cut short by caller or per-request deadlines', async t => {
  const slow = slowBody('{"access_token":"private-new-access"}');
  t.mock.method(globalThis, 'fetch', slow.fetchMock);
  const caller = new AbortController();
  const pending = exchangeToken('https://api.ibkr.com/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token' }), signal: caller.signal });
  // The old path aborted here: the caller's renewal deadline and the 45-second request limit.
  caller.abort(new DOMException('fixture-deadline', 'TimeoutError'));
  await new Promise(resolve => setTimeout(resolve, 20));
  slow.release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { access_token: 'private-new-access' });
});

test('a token body that never completes is reported as a lost response, not a retryable failure', async t => {
  let calls = 0;
  const slow = slowBody('{}');
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => { calls++; return slow.fetchMock(url, init); });
  // AbortSignal.timeout does not hold the event loop open; the service always has other handles.
  const alive = setTimeout(() => {}, 5000);
  const error = await exchangeToken('https://api.ibkr.com/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token' }) }, 30)
    .then(() => assert.fail('expected a lost response'), error => error)
    .finally(() => clearTimeout(alive));
  assert.ok(error instanceof IbkrResponseLostError);
  assert.equal(error.status, 200);
  assert.equal(readFailureReason(error), 'response_lost');
  assert.equal(calls, 1);
  await assert.rejects(exchangeToken('https://example.com/oauth2/token', { method: 'POST' }));
  assert.equal(calls, 1);
});

// A local proxy that answers every CONNECT the way the IB egress proxy does on a bad upstream.
async function refusingProxy(t: { after(fn: () => unknown): void }) {
  const { createServer } = await import('node:net');
  const server = createServer(socket => socket.once('data', () => {
    connects++; socket.end('HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\n\r\n');
  }));
  let connects = 0;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, connects: () => connects };
}

test('a proxy that refuses the tunnel never reached IB, so reads and token exchanges retry it', async t => {
  const logs = t.mock.method(console, 'info', () => {});
  const proxy = await refusingProxy(t);
  const previous = process.env.IBKR_TOKEN_HTTP_PROXY;
  process.env.IBKR_TOKEN_HTTP_PROXY = proxy.url;
  t.after(() => { if (previous === undefined) delete process.env.IBKR_TOKEN_HTTP_PROXY; else process.env.IBKR_TOKEN_HTTP_PROXY = previous; });
  // Real undici, so a changed error shape fails here rather than in production.
  const error = await exchangeToken('https://api.ibkr.com/oauth2/token', { method: 'POST', body: 'private-grant' }).then(() => assert.fail('expected a refused tunnel'), error => error);
  assert.equal(proxy.connects(), 2);
  assert.ok(!(error instanceof IbkrResponseLostError));
  assert.equal(readFailureReason(error), 'proxy_tunnel_failed');
  const exchange = logs.mock.calls.map(call => JSON.parse(call.arguments[0])).find(log => log.event === 'ibkr_token_exchange');
  assert.equal(exchange.reason, 'proxy_tunnel_failed');
  assert.doesNotMatch(JSON.stringify(logs.mock.calls), /private-grant/);

  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { if (!calls++) throw error; return Response.json({ ok: true }); });
  assert.equal((await restrictedFetch('https://api.ibkr.com/v1/api/mcp-public')).status, 200);
  assert.equal(calls, 2);
});

test('other aborted requests are not mistaken for a refused tunnel', async t => {
  t.mock.method(console, 'info', () => {});
  let calls = 0;
  const aborted = new TypeError('fetch failed', { cause: Object.assign(new Error('Request aborted'), { name: 'AbortError', code: 'UND_ERR_ABORTED' }) });
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw aborted; });
  const error = await restrictedFetch('https://api.ibkr.com/v1/api/mcp-public').then(() => assert.fail('expected an abort'), error => error);
  assert.equal(calls, 1);
  assert.notEqual(readFailureReason(error), 'proxy_tunnel_failed');
  await assert.rejects(exchangeToken('https://api.ibkr.com/oauth2/token', { method: 'POST' }), IbkrResponseLostError);
  assert.equal(calls, 2);
});
