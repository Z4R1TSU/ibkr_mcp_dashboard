import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IbkrClient, IbkrOAuth } from '../server/ibkr.js';
import { Vault } from '../server/vault.js';
import { config } from '../server/config.js';

interface McpRequest { method: string; authorization: string | null; headers: Headers; message?: any; signal?: AbortSignal | null }
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-session-test-'));
  const vault = new Vault(directory), oauth = new IbkrOAuth(vault), client = new IbkrClient(oauth);
  oauth.saveClientInformation({ ...oauth.clientMetadata, client_id: 'fixture-client' });
  oauth.saveTokens({ access_token: 'fixture-old-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read', expires_in: 600 });
  const logs: any[] = [], calls: McpRequest[] = [], tokenBodies: URLSearchParams[] = [];
  const handlers: {
    mcp?: (request: McpRequest) => Response | undefined | Promise<Response | undefined>;
    token?: () => Response | Promise<Response>;
  } = {};
  t.mock.method(console, 'info', (message: string) => { logs.push(JSON.parse(message)); });
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://api.ibkr.com');
    if (url.href === config.serverUrl) {
      const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);
      const call = { method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        authorization: new Headers(init?.headers).get('Authorization'), headers: new Headers(init?.headers), message: body ? JSON.parse(String(body)) : undefined, signal: init?.signal };
      calls.push(call);
      const response = await handlers.mcp?.(call);
      if (response) return response;
      if (call.method === 'GET') return new Response('', { status: 405 });
      if (!call.message?.id && call.message?.id !== 0) return new Response(null, { status: 202 });
      const result = call.message.method === 'initialize'
        ? { protocolVersion: call.message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { content: [], structuredContent: { ok: true } };
      return Response.json({ jsonrpc: '2.0', id: call.message.id, result });
    }
    if (url.pathname.includes('oauth-protected-resource')) return Response.json({
      resource: config.serverUrl, authorization_servers: [url.origin], scopes_supported: ['mcp.read'],
    });
    if (url.pathname.includes('oauth-authorization-server')) return Response.json({
      issuer: url.origin, authorization_endpoint: url.origin + '/authorize', token_endpoint: url.origin + '/token',
      response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
    });
    if (url.pathname === '/token') {
      const body = new URLSearchParams(String(init?.body)); tokenBodies.push(body);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('resource'), config.serverUrl);
      return handlers.token ? handlers.token() : refreshed();
    }
    throw new Error('Unexpected mock OAuth request');
  });
  t.after(async () => { await client.disconnect(); fs.rmSync(directory, { recursive: true }); });
  return { directory, vault, oauth, client, logs, calls, tokenBodies, handlers };
}

function refreshed(): Response {
  return Response.json({ access_token: 'fixture-new-access', refresh_token: 'fixture-rotated-refresh', token_type: 'Bearer', scope: 'mcp.read', expires_in: 600 });
}
function rejected(status = 401): Response {
  return new Response('private-fixture-response', { status, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
}
function noBrowserLogin(f: ReturnType<typeof fixture>) {
  assert.equal(f.vault.get().oauth?.state, undefined);
  assert.equal(f.vault.get().oauth?.authorizationUrl, undefined);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-fixture|fixture-old-access|fixture-new-access|fixture-refresh|fixture-rotated-refresh/);
}

test('initialization, tool requests and SSE use the same refresh path', async t => {
  for (const stage of ['initialize', 'tools/call', 'GET']) await t.test(stage, async subtest => {
    const f = fixture(subtest);
    const sseRetried = Promise.withResolvers<void>();
    f.handlers.mcp = request => {
      if (request.method === 'GET' && request.authorization === 'Bearer fixture-new-access') sseRetried.resolve();
      return (request.message?.method === stage || request.method === stage) && request.authorization === 'Bearer fixture-old-access' ? rejected() : undefined;
    };
    assert.deepEqual(await f.client.call('get_account_positions'), { ok: true });
    if (stage === 'GET') await sseRetried.promise;
    assert.equal(f.tokenBodies.length, 1);
    assert.equal(f.vault.get().oauth?.tokens?.refresh_token, 'fixture-rotated-refresh');
    assert.equal(new Vault(f.directory).get().oauth?.tokens?.refresh_token, 'fixture-rotated-refresh');
    assert.ok(f.logs.some(log => log.event === 'ibkr_token_refresh' && log.trigger === 'http_401' && log.outcome === 'success'));
    assert.ok(f.calls.some(call => call.authorization === 'Bearer fixture-new-access'));
    noBrowserLogin(f);
  });
});

test('proactive refresh shares the same log and avoids sending an expired token', async t => {
  const f = fixture(t);
  f.vault.update(value => { value.oauth!.expiresAt = Date.now() - 1000; });
  assert.deepEqual(await f.client.call('get_account_positions'), { ok: true });
  assert.equal(f.tokenBodies.length, 1);
  assert.ok(f.calls.every(call => call.authorization === 'Bearer fixture-new-access'));
  assert.ok(f.logs.some(log => log.trigger === 'expiry' && log.outcome === 'success'));
  noBrowserLogin(f);
});

test('401 refresh failures preserve credentials and recover on the next read', async t => {
  const failures = [
    { name: 'network', token: () => { throw new TypeError('private-fixture-network'); } },
    { name: 'timeout', token: () => { throw new DOMException('private-fixture-timeout', 'TimeoutError'); } },
    { name: 'server', token: () => Response.json({ error: 'server_error', error_description: 'private-fixture' }, { status: 503 }) },
    { name: 'rate limit', token: () => Response.json({ error: 'temporarily_unavailable' }, { status: 429 }) },
  ];
  for (const failure of failures) await t.test(failure.name, async subtest => {
    const f = fixture(subtest), saved = structuredClone(f.vault.get());
    f.handlers.mcp = request => request.message?.method === 'tools/call' && request.authorization === 'Bearer fixture-old-access' ? rejected() : undefined;
    f.handlers.token = failure.token;
    await assert.rejects(f.client.call('get_account_positions'));
    assert.deepEqual(f.vault.get(), saved);
    assert.notEqual(f.oauth.authStatus(), 'login_required');
    assert.equal(f.tokenBodies.length, 1);
    assert.ok(f.logs.some(log => log.trigger === 'http_401' && log.requiresLogin === false));
    f.handlers.token = undefined;
    assert.deepEqual(await f.client.call('get_account_positions'), { ok: true });
    assert.equal(f.tokenBodies.length, 2);
    noBrowserLogin(f);
  });
});

test('explicit refresh rejection logs the OAuth code without launching browser auth', async t => {
  for (const code of ['invalid_grant', 'invalid_client', 'unauthorized_client']) await t.test(code, async subtest => {
    const f = fixture(subtest);
    f.handlers.mcp = request => request.message?.method === 'tools/call' ? rejected() : undefined;
    f.handlers.token = () => Response.json({ error: code, error_description: 'private-fixture-description' }, { status: 400 });
    await assert.rejects(f.client.call('get_account_positions'));
    assert.equal(f.vault.get().oauth?.tokens, undefined);
    assert.equal(Boolean(f.vault.get().oauth?.client), code === 'invalid_grant');
    assert.equal(f.oauth.authStatus(), 'login_required');
    assert.equal(new IbkrOAuth(new Vault(f.directory)).authStatus(), 'login_required');
    assert.equal(f.tokenBodies.length, 1);
    assert.ok(f.logs.some(log => log.event === 'ibkr_token_refresh' && log.trigger === 'http_401' && log.reason === code && log.requiresLogin));
    assert.ok(f.logs.some(log => log.event === 'ibkr_read' && log.reason === code));
    const requestCount = f.calls.length;
    await assert.rejects(f.client.call('get_account_positions'));
    assert.equal(f.calls.length, requestCount);
    assert.ok(f.logs.some(log => log.event === 'ibkr_read' && log.reason === 'authorization_required'));
    noBrowserLogin(f);
  });
});

test('repeated 401 and insufficient scope never loop, clear credentials or expand access', async t => {
  for (const status of [401, 403]) await t.test(String(status), async subtest => {
    const f = fixture(subtest);
    f.handlers.mcp = request => request.message?.method === 'tools/call'
      ? new Response('private-fixture-response', { status, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="mcp.write"' } }) : undefined;
    await assert.rejects(f.client.call('get_account_positions'));
    assert.equal(f.tokenBodies.length, status === 401 ? 1 : 0);
    assert.equal(f.calls.filter(call => call.message?.method === 'tools/call').length, status === 401 ? 2 : 1);
    assert.ok(f.vault.get().oauth?.tokens?.refresh_token);
    assert.equal(f.oauth.authStatus(), status === 401 ? 'login_required' : 'ready');
    assert.equal(new IbkrOAuth(new Vault(f.directory)).authStatus(), f.oauth.authStatus());
    assert.ok(f.logs.some(log => log.event === 'ibkr_read' && log.reason === `http_${status}`));
    noBrowserLogin(f);
  });
});

test('missing refresh token is diagnosed and no interactive flow starts', async t => {
  const f = fixture(t);
  delete f.vault.get().oauth!.tokens!.refresh_token;
  f.handlers.mcp = () => rejected();
  await assert.rejects(f.client.call('get_account_positions'));
  assert.equal(f.tokenBodies.length, 0);
  assert.ok(f.logs.some(log => log.reason === 'missing_refresh_token' && log.requiresLogin));
  assert.equal(f.oauth.authStatus(), 'login_required');
  noBrowserLogin(f);
});

test('cancelling one 401 reader preserves the shared rotation for other readers', async t => {
  const f = fixture(t), controller = new AbortController();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  f.handlers.mcp = request => request.authorization === 'Bearer fixture-old-access' ? rejected() : undefined;
  f.handlers.token = async () => { started.resolve(); await finish.promise; return refreshed(); };
  const cancelled = assert.rejects(f.oauth.mcpFetch(config.serverUrl, { signal: controller.signal }), { name: 'AbortError' });
  await started.promise;
  const surviving = f.oauth.mcpFetch(config.serverUrl);
  controller.abort(); await cancelled;
  finish.resolve();
  assert.equal((await surviving).status, 405);
  assert.equal(f.tokenBodies.length, 1);
  assert.equal(new Vault(f.directory).get().oauth?.tokens?.refresh_token, 'fixture-rotated-refresh');
  noBrowserLogin(f);
});

test('a delayed 401 reuses a completed rotation instead of spending the new refresh token', async t => {
  const f = fixture(t), delayed = Promise.withResolvers<void>();
  let oldCalls = 0;
  f.handlers.mcp = async request => {
    if (request.authorization !== 'Bearer fixture-old-access') return;
    if (++oldCalls === 2) await delayed.promise;
    return rejected();
  };
  const first = f.oauth.mcpFetch(config.serverUrl), second = f.oauth.mcpFetch(config.serverUrl);
  assert.equal((await first).status, 405);
  delayed.resolve();
  assert.equal((await second).status, 405);
  assert.equal(f.tokenBodies.length, 1);
  noBrowserLogin(f);
});

test('MCP authorization never sends credentials to discovery, token or foreign URLs', async t => {
  const f = fixture(t);
  for (const url of ['https://example.com/', 'https://api.ibkr.com/token', config.serverUrl + '?redirect=other']) {
    await assert.rejects(f.oauth.mcpFetch(url), /拒绝非 IB MCP 接口/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.tokenBodies.length, 0);
});

test('a Request body and MCP headers survive the single authenticated replay', async t => {
  const f = fixture(t);
  f.handlers.mcp = request => request.authorization === 'Bearer fixture-old-access' ? rejected() : undefined;
  const message = { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'get_account_positions' } };
  const request = new Request(config.serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fixture-session' }, body: JSON.stringify(message) });
  assert.equal((await f.oauth.mcpFetch(request)).status, 200);
  assert.deepEqual(f.calls.map(call => call.message), [message, message]);
  assert.ok(f.calls.every(call => call.headers.get('Mcp-Session-Id') === 'fixture-session' && call.headers.get('Content-Type') === 'application/json'));
  assert.equal(f.tokenBodies.length, 1);
  noBrowserLogin(f);
});
