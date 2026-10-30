import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../server/vault.js';
import { IbkrOAuth } from '../server/ibkr.js';

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-oauth-test-'));
  const vault = new Vault(directory);
  const oauth = new IbkrOAuth(vault);
  const requests: { path: string; method: string; body: string }[] = [];
  const responses = { resourceStatus: 200, tokenError: '', tokenStatus: 400, tokenScope: 'mcp.read',
    tokenFailure: null as Error | null, refreshToken: 'fixture-refresh' as string | undefined, expectedRefresh: 'fixture-refresh' };
  const logs = t.mock.method(console, 'info', () => {});
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://api.ibkr.com');
    assert.ok(init?.signal);
    const method = init?.method ?? 'GET', body = String(init?.body ?? '');
    requests.push({ path: url.pathname, method, body });
    if (url.pathname === '/v1/api/mcp-public/.well-known/oauth-protected-resource') {
      if (responses.resourceStatus !== 200) return new Response('', { status: responses.resourceStatus });
      return Response.json({ resource: 'https://api.ibkr.com/v1/api/mcp-public', authorization_servers: [url.origin], scopes_supported: ['mcp.read', 'mcp.write', 'mcp.orders.submit'] });
    }
    if (url.pathname.includes('oauth-protected-resource')) return new Response('', { status: 404 });
    if (url.pathname === '/.well-known/oauth-authorization-server') return Response.json({
      issuer: url.origin, authorization_endpoint: url.origin + '/oauth2/authorize',
      token_endpoint: url.origin + '/oauth2/token', registration_endpoint: url.origin + '/oauth2/register',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    });
    if (url.pathname === '/oauth2/register') {
      assert.equal(method, 'POST');
      const metadata = JSON.parse(body);
      assert.equal(metadata.scope, 'mcp.read');
      return Response.json({ ...metadata, client_id: 'registered-fixture-client' }, { status: 201 });
    }
    if (url.pathname === '/oauth2/token') {
      if (responses.tokenFailure) throw responses.tokenFailure;
      if (responses.tokenError) return Response.json({ error: responses.tokenError, error_description: 'private-fixture-description' }, { status: responses.tokenStatus });
      const params = new URLSearchParams(body);
      assert.equal(params.get('resource'), 'https://api.ibkr.com/v1/api/mcp-public');
      if (params.get('grant_type') === 'refresh_token') assert.equal(params.get('refresh_token'), responses.expectedRefresh);
      else {
        assert.equal(params.get('grant_type'), 'authorization_code');
        assert.equal(params.get('code_verifier'), vault.get().oauth?.verifier);
      }
      return Response.json({ access_token: 'fixture-access', refresh_token: responses.refreshToken, token_type: 'Bearer', scope: responses.tokenScope, expires_in: 3600 });
    }
    throw new Error('Unexpected OAuth request: ' + url.pathname);
  });
  const registerExisting = () => oauth.saveClientInformation({ ...oauth.clientMetadata, client_id: 'existing-fixture-client', scope: 'mcp.orders.submit mcp.read mcp.write' });
  return { vault, oauth, requests, responses, logs, registerExisting, clean: () => fs.rmSync(directory, { recursive: true }) };
}

test('login status does not mistake renewable token expiry for lost authorization', t => {
  const f = fixture(t);
  try {
    assert.equal(f.oauth.authStatus(), 'login_required');
    f.registerExisting();
    f.oauth.saveTokens({ access_token: 'fixture', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read', expires_in: 10 });
    const future = Date.now() + 20000;
    assert.equal(f.oauth.authStatus(), 'ready');
    assert.equal(f.oauth.authStatus(future), 'unknown');
    delete f.vault.get().oauth!.tokens!.refresh_token;
    assert.equal(f.oauth.authStatus(future), 'login_required');
    assert.equal(f.requests.length, 0);
  } finally { f.clean(); }
});

test('a confirmed login failure survives refresh and is cleared by completed authorization', async t => {
  const f = fixture(t);
  try {
    f.registerExisting();
    f.oauth.saveTokens({ access_token: 'old', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read' });
    f.vault.update(value => { value.oauth!.loginRequired = true; });
    await f.oauth.refreshTokens();
    assert.equal(f.oauth.authStatus(), 'login_required');
    const address = new URL(await f.oauth.begin());
    assert.equal(f.oauth.authStatus(), 'login_required');
    await f.oauth.complete('fixture-code', address.searchParams.get('state')!);
    assert.equal(f.oauth.authStatus(), 'ready');
    assert.equal(new IbkrOAuth(new Vault(f.vault.directory)).authStatus(), 'ready');
  } finally { f.clean(); }
});

test('preloading is read-only, repeated login uses cached discovery and registration, and callback exchanges only once', async t => {
  const f = fixture(t);
  try {
    f.registerExisting();
    f.oauth.saveTokens({ access_token: 'previous-access', token_type: 'Bearer', scope: 'mcp.read' });
    const previousTokens = f.vault.get().oauth!.tokens;
    await f.oauth.prepare();
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(request => request.method === 'GET'));
    assert.equal(f.vault.get().oauth!.tokens, previousTokens);
    const first = new URL(await f.oauth.begin());
    const verifier = f.vault.get().oauth!.verifier;
    const second = new URL(await f.oauth.begin());
    assert.equal(f.oauth.authStatus(), 'unknown');
    assert.equal(f.requests.length, 2);
    assert.equal(second.searchParams.get('client_id'), 'existing-fixture-client');
    assert.equal(second.searchParams.get('scope'), 'mcp.read');
    assert.equal(second.searchParams.get('redirect_uri'), f.oauth.redirectUrl);
    assert.equal(second.searchParams.get('resource'), 'https://api.ibkr.com/v1/api/mcp-public');
    assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
    assert.notEqual(verifier, f.vault.get().oauth!.verifier);
    await assert.rejects(f.oauth.complete('fixture-code', first.searchParams.get('state')!));
    assert.equal(f.requests.length, 2);
    await f.oauth.complete('fixture-code', second.searchParams.get('state')!);
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests.at(-1)!.path, '/oauth2/token');
    assert.equal(f.vault.get().oauth?.tokens?.access_token, 'fixture-access');
    assert.equal(f.oauth.authStatus(), 'ready');
    assert.equal(f.vault.get().oauth?.verifier, undefined);
    assert.equal(f.vault.get().oauth?.state, undefined);
    await assert.rejects(f.oauth.complete('fixture-code', second.searchParams.get('state')!));
    assert.equal(f.requests.length, 3);
    const logs = f.logs.mock.calls.map(call => call.arguments.join(' ')).join('\n');
    assert.doesNotMatch(logs, /fixture-code|fixture-access|fixture-refresh|previous-access/);
  } finally { f.clean(); }
});

test('token refresh uses the advertised MCP resource without starting another browser authorization', async t => {
  const f = fixture(t);
  try {
    f.registerExisting();
    f.oauth.saveTokens({ access_token: 'old-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read' });
    assert.equal(await f.oauth.refreshTokens(), 'AUTHORIZED');
    assert.equal(f.requests.filter(r => r.path === '/oauth2/token').length, 1);
    assert.equal(f.requests.filter(r => r.path === '/oauth2/register').length, 0);
    assert.equal(f.vault.get().oauth?.state, undefined);
    assert.equal(f.vault.get().oauth?.authorizationUrl, undefined);
    assert.equal(f.vault.get().oauth?.tokens?.access_token, 'fixture-access');
  } finally { f.clean(); }
});

test('background refresh preserves authorization on transient failures and recovers without login', async t => {
  for (const failure of [
    { name: 'timeout', tokenFailure: new DOMException('private-fixture-description', 'TimeoutError') },
    { name: 'network', tokenFailure: new TypeError('private-fixture-description') },
    { name: 'server', tokenError: 'server_error', tokenStatus: 503 },
    { name: 'rate limit', tokenError: 'temporarily_unavailable', tokenStatus: 429 },
    { name: 'other rejection', tokenError: 'invalid_scope', tokenStatus: 400 },
  ]) await t.test(failure.name, async subtest => {
    const f = fixture(subtest);
    try {
      f.registerExisting();
      f.oauth.saveTokens({ access_token: 'old-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read', expires_in: 600 });
      const previous = structuredClone(f.vault.get());
      Object.assign(f.responses, failure);
      await assert.rejects(f.oauth.refreshTokens());
      assert.deepEqual(f.vault.get(), previous);
      const logs = f.logs.mock.calls.map(call => call.arguments.join(' ')).join('\n');
      assert.match(logs, /ibkr_token_refresh/);
      assert.doesNotMatch(logs, /private-fixture-description|old-access|fixture-refresh/);
      f.responses.tokenFailure = null;
      f.responses.tokenError = '';
      assert.equal(await f.oauth.refreshTokens(), 'AUTHORIZED');
      assert.equal(f.vault.get().oauth?.tokens?.access_token, 'fixture-access');
      assert.equal(f.vault.get().oauth?.state, undefined);
      assert.equal(f.vault.get().oauth?.authorizationUrl, undefined);
      assert.equal(f.requests.filter(r => r.path === '/oauth2/register').length, 0);
    } finally { f.clean(); }
  });
});

test('rejected refresh credentials require login without silently starting a new authorization', async t => {
  for (const code of ['invalid_grant', 'invalid_client', 'unauthorized_client']) await t.test(code, async subtest => {
    const f = fixture(subtest);
    try {
      f.registerExisting();
      f.oauth.saveTokens({ access_token: 'old-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read' });
      f.vault.update(value => { value.oauth!.expiresAt = Date.now() + 600000; });
      f.responses.tokenError = code;
      await assert.rejects(f.oauth.refreshTokens());
      assert.equal(f.vault.get().oauth?.tokens, undefined);
      assert.equal(f.vault.get().oauth?.expiresAt, undefined);
      assert.equal(f.vault.get().oauth?.state, undefined);
      assert.equal(f.vault.get().oauth?.authorizationUrl, undefined);
      assert.equal(Boolean(f.vault.get().oauth?.client), code === 'invalid_grant');
      assert.equal(f.requests.filter(r => r.path === '/oauth2/token').length, 1);
      assert.equal(f.requests.filter(r => r.path === '/oauth2/register').length, 0);
      const logs = f.logs.mock.calls.map(call => call.arguments.join(' ')).join('\n');
      assert.ok(logs.includes(code));
      assert.doesNotMatch(logs, /private-fixture-description|old-access|fixture-refresh/);
    } finally { f.clean(); }
  });
});

test('concurrent refresh shares one rotation and saves the rotated credential across restarts', async t => {
  const f = fixture(t);
  try {
    f.registerExisting();
    f.oauth.saveTokens({ access_token: 'old-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read' });
    f.responses.refreshToken = 'rotated-fixture-refresh';
    const results = await Promise.all([f.oauth.refreshTokens(), f.oauth.refreshTokens(), f.oauth.refreshTokens()]);
    assert.deepEqual(results, ['AUTHORIZED', 'AUTHORIZED', 'AUTHORIZED']);
    assert.equal(f.requests.filter(r => r.path === '/oauth2/token').length, 1);
    assert.equal(new Vault(f.vault.directory).get().oauth?.tokens?.refresh_token, 'rotated-fixture-refresh');
    f.responses.expectedRefresh = 'rotated-fixture-refresh';
    f.responses.refreshToken = undefined;
    await f.oauth.refreshTokens();
    assert.equal(f.vault.get().oauth?.tokens?.refresh_token, 'rotated-fixture-refresh');
  } finally { f.clean(); }
});

test('a slow background refresh can finish after the browser preparation deadline', async t => {
  const f = fixture(t);
  const deadlines: { ms: number; controller: AbortController }[] = [];
  const originalFetch = globalThis.fetch;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const controller = new AbortController();
    deadlines.push({ ms, controller });
    return controller.signal;
  });
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const response = await originalFetch(input, init);
    if (String(input).endsWith('/oauth2/token')) {
      // Simulate a response at 25 seconds, after the old browser deadline.
      for (const deadline of deadlines) if (deadline.ms <= 25000) deadline.controller.abort(new DOMException('fixture-timeout', 'TimeoutError'));
      init?.signal?.throwIfAborted();
    }
    return response;
  });
  try {
    f.registerExisting();
    f.oauth.saveTokens({ access_token: 'old-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read' });
    f.responses.refreshToken = 'rotated-fixture-refresh';
    assert.equal(await f.oauth.refreshTokens(), 'AUTHORIZED');
    assert.equal(f.vault.get().oauth?.tokens?.refresh_token, 'rotated-fixture-refresh');
  } finally { f.clean(); }
});

// 2026-10-18: IB answered 200 within 5 seconds, so the old refresh token was
// already revoked, but the body arrived after the renewal deadline. Aborting
// lost the only copy of the new token and the next attempt got invalid_grant.
test('a rotated token whose body arrives after every caller deadline is still saved', async t => {
  const f = fixture(t);
  const deadlines: AbortController[] = [];
  const originalFetch = globalThis.fetch;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const controller = new AbortController();
    if (ms <= 60000) deadlines.push(controller);
    return controller.signal;
  });
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const response = await originalFetch(input, init);
    if (!String(input).endsWith('/oauth2/token')) return response;
    const body = await response.text();
    return new Response(new ReadableStream({
      async start(controller) {
        // Headers are out; every renewal and per-request deadline now expires.
        for (const deadline of deadlines) deadline.abort(new DOMException('fixture-timeout', 'TimeoutError'));
        await new Promise(resolve => setTimeout(resolve, 10));
        init?.signal?.throwIfAborted();
        controller.enqueue(new TextEncoder().encode(body)); controller.close();
      },
    }), { status: response.status, headers: response.headers });
  });
  try {
    f.registerExisting();
    f.oauth.saveTokens({ access_token: 'old-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read', expires_in: 600 });
    f.responses.refreshToken = 'rotated-fixture-refresh';
    assert.equal(await f.oauth.refreshTokens(), 'AUTHORIZED');
    assert.equal(new Vault(f.vault.directory).get().oauth?.tokens?.refresh_token, 'rotated-fixture-refresh');
    assert.equal(f.requests.filter(r => r.path === '/oauth2/token').length, 1);
  } finally { f.clean(); }
});

test('a lost token body keeps the saved credentials and reports response_lost without replaying', async t => {
  const f = fixture(t);
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const response = await originalFetch(input, init);
    if (!String(input).endsWith('/oauth2/token')) return response;
    return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('private-fixture-description')); } }), { status: 200 });
  });
  try {
    f.registerExisting();
    f.oauth.saveTokens({ access_token: 'old-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read', expires_in: 600 });
    const previous = structuredClone(f.vault.get());
    await assert.rejects(f.oauth.refreshTokens());
    assert.deepEqual(f.vault.get(), previous);
    assert.equal(f.requests.filter(r => r.path === '/oauth2/token').length, 1);
    const logs = f.logs.mock.calls.map(call => call.arguments.join(' ')).join('\n');
    assert.match(logs, /"path":"\/oauth2\/token","method":"POST","status":200/);
    assert.match(logs, /"reason":"response_lost"/);
    assert.doesNotMatch(logs, /private-fixture-description|old-access|fixture-refresh/);
  } finally { f.clean(); }
});

test('a login code exchange that finishes after the preparation deadline completes the login', async t => {
  const f = fixture(t);
  const deadlines: AbortController[] = [];
  const originalFetch = globalThis.fetch;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const controller = new AbortController();
    if (ms <= 20000) deadlines.push(controller);
    return controller.signal;
  });
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const response = await originalFetch(input, init);
    if (String(input).endsWith('/oauth2/token')) for (const deadline of deadlines) deadline.abort(new DOMException('fixture-timeout', 'TimeoutError'));
    return response;
  });
  try {
    f.registerExisting();
    const state = new URL(await f.oauth.begin()).searchParams.get('state')!;
    deadlines.length = 0;
    await f.oauth.complete('fixture-code', state);
    assert.equal(f.vault.get().oauth?.tokens?.access_token, 'fixture-access');
    assert.equal(f.vault.get().oauth?.verifier, undefined);
  } finally { f.clean(); }
});

test('refresh rejects unavailable discovery and broad token scope without changing saved credentials', async t => {
  for (const failure of [{ resourceStatus: 500 }, { tokenScope: 'mcp.read mcp.write' }]) await t.test(JSON.stringify(failure), async subtest => {
    const f = fixture(subtest);
    try {
      f.registerExisting();
      f.oauth.saveTokens({ access_token: 'old-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read' });
      const previous = structuredClone(f.vault.get());
      Object.assign(f.responses, failure);
      await assert.rejects(f.oauth.refreshTokens());
      assert.deepEqual(f.vault.get(), previous);
      if (failure.resourceStatus) assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
    } finally { f.clean(); }
  });
});

test('new or changed callback registrations are created once, and discovery refreshes after expiry or invalidation', async t => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    await f.oauth.begin();
    assert.equal(f.requests.filter(request => request.path === '/oauth2/register').length, 1);
    await f.oauth.begin();
    assert.equal(f.requests.length, 3);
    f.oauth.saveClientInformation({ ...f.oauth.clientMetadata, client_id: 'old-port-client', redirect_uris: ['http://127.0.0.1:62481/auth/ibkr/callback'] });
    await f.oauth.begin();
    assert.equal(f.requests.filter(request => request.path === '/oauth2/register').length, 2);
    now += 3600001;
    await f.oauth.begin();
    assert.equal(f.requests.length, 6);
    f.oauth.invalidateCredentials('discovery');
    await f.oauth.begin();
    assert.equal(f.requests.length, 8);
  } finally { f.clean(); }
});

test('temporary metadata errors are retried and a rejected client is discarded before re-registration', async t => {
  const f = fixture(t);
  try {
    f.registerExisting();
    f.responses.resourceStatus = 500;
    await assert.rejects(f.oauth.begin());
    await assert.rejects(f.oauth.begin());
    assert.equal(f.vault.get().oauth?.authorizationUrl, undefined);
    assert.equal(f.requests.filter(request => request.path.includes('oauth-protected-resource')).length, 2);
    f.responses.resourceStatus = 404;
    await assert.rejects(f.oauth.begin());
    assert.equal(f.vault.get().oauth?.authorizationUrl, undefined);
    f.responses.resourceStatus = 200;
    const url = new URL(await f.oauth.begin());
    f.responses.tokenError = 'invalid_client';
    await assert.rejects(f.oauth.complete('fixture-code', url.searchParams.get('state')!));
    assert.equal(f.vault.get().oauth?.client, undefined);
    assert.equal(f.vault.get().oauth?.tokens, undefined);
    f.responses.tokenError = '';
    await f.oauth.begin();
    assert.equal(f.requests.filter(request => request.path === '/oauth2/register').length, 1);
  } finally { f.clean(); }
});

test('broad client capabilities never allow a broader account authorization', async t => {
  const f = fixture(t);
  try {
    f.registerExisting();
    const url = new URL(await f.oauth.begin());
    assert.equal(url.searchParams.get('scope'), 'mcp.read');
    assert.equal(f.requests.filter(request => request.path === '/oauth2/register').length, 0);
    f.responses.tokenScope = 'mcp.read mcp.write';
    await assert.rejects(f.oauth.complete('fixture-code', url.searchParams.get('state')!), /拒绝非 mcp.read 授权/);
    assert.equal(f.vault.get().oauth?.tokens, undefined);
  } finally { f.clean(); }
});

test('an expired preparation deadline cannot fall back to an unverified authorization URL', async t => {
  const f = fixture(t);
  try {
    f.registerExisting();
    await f.oauth.prepare();
    const count = f.requests.length;
    t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new DOMException('fixture-deadline', 'TimeoutError')));
    await assert.rejects(f.oauth.begin(), { name: 'TimeoutError' });
    assert.equal(f.requests.length, count);
    assert.equal(f.vault.get().oauth?.authorizationUrl, undefined);
    assert.equal(f.vault.get().oauth?.tokens, undefined);
  } finally { f.clean(); }
});

test('a transient renewal failure preserves valid discovery instead of fetching it again', async t => {
  const f = fixture(t);
  try {
    f.registerExisting();
    f.oauth.saveTokens({ access_token: 'old-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', scope: 'mcp.read' });
    await f.oauth.refreshTokens();
    f.requests.length = 0;
    f.responses.tokenFailure = new TypeError('fixture-network-failure');
    await assert.rejects(f.oauth.refreshTokens());
    f.responses.tokenFailure = null;
    await f.oauth.refreshTokens();
    assert.deepEqual(f.requests.map(request => request.path), ['/oauth2/token', '/oauth2/token']);
  } finally { f.clean(); }
});
