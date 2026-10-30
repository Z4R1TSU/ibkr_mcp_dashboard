import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, discoverOAuthProtectedResourceMetadata, discoverOAuthServerInfo, refreshAuthorization, selectResourceURL, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidClientError, InvalidGrantError, OAuthError, UnauthorizedClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from './config.js';
import { Vault } from './vault.js';
import { restrictedFetch, exchangeToken, readFailureReason, IbkrLoginRequiredError, IbkrResponseLostError } from './ibkr-fetch.js';
import { ReadQueue, waitFor } from './read-queue.js';
import type { BrokerAuthState } from '../shared/broker-auth.js';

export const READ_TOOLS = new Set(['get_account_positions', 'get_account_summary', 'get_account_balances', 'get_price_snapshot', 'get_pa_allocation', 'get_pa_performance_all_periods', 'get_account_trades', 'get_account_orders', 'search_contracts', 'get_price_history']);

// IB advertises this nested URL in its MCP 401 WWW-Authenticate challenge.
const resourceMetadataUrl = new URL(config.serverUrl + '/.well-known/oauth-protected-resource');

export function validateReadScope(scope: string | undefined): void {
  if (scope?.trim() !== 'mcp.read') throw new Error('拒绝非 mcp.read 授权');
}

export class IbkrOAuth implements OAuthClientProvider {
  private readonly metadata = new Map<string, { expires: number; status: number; body: string }>();
  private refreshPending?: Promise<'AUTHORIZED'>;
  private authenticationPending = 0;
  constructor(readonly vault: Vault) {}
  authStatus(now = Date.now()): BrokerAuthState {
    const oauth = this.vault.get().oauth;
    if (oauth?.loginRequired) return 'login_required';
    if (this.authenticationPending) return 'unknown';
    if (!oauth?.tokens?.access_token) {
      return oauth?.stateExpiresAt && oauth.stateExpiresAt > now ? 'unknown' : 'login_required';
    }
    if (!oauth.client) return 'login_required';
    const expired = !!oauth.expiresAt && oauth.expiresAt <= now;
    if (expired && !oauth.tokens.refresh_token) return 'login_required';
    return this.refreshPending || expired ? 'unknown' : 'ready';
  }
  private markLoginRequired(): void {
    if (!this.vault.get().oauth?.loginRequired) this.vault.update(value => { (value.oauth ??= {}).loginRequired = true; });
  }
  private markAuthorized(): void {
    if (this.vault.get().oauth?.loginRequired) this.vault.update(value => { delete value.oauth!.loginRequired; });
  }
  private async authorizationFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const cacheable = method === 'GET' && url.origin === 'https://api.ibkr.com' && url.pathname.includes('/.well-known/') && !url.search;
    const cached = cacheable ? this.metadata.get(url.href) : undefined;
    if (cached && cached.expires > Date.now()) return new Response(cached.body, { status: cached.status, headers: { 'Content-Type': 'application/json' } });
    // The SDK sends code and refresh grants as form parameters; registration is JSON.
    const exchange = method === 'POST' && init?.body instanceof URLSearchParams && init.body.has('grant_type');
    const started = Date.now();
    let status: number | null = null;
    try {
      const response = exchange ? await exchangeToken(input, init) : await restrictedFetch(input, init);
      status = response.status;
      if (cacheable && (status === 200 || status === 404)) {
        const body = await response.text();
        if (Buffer.byteLength(body) <= 65536) this.metadata.set(url.href, { expires: Date.now() + 3600000, status, body });
        return new Response(body, { status, headers: response.headers });
      }
      return response;
    } catch (error) {
      if (error instanceof IbkrResponseLostError) status = error.status;
      throw error;
    } finally {
      console.info(JSON.stringify({ event: 'ibkr_authorization_http', path: url.pathname, method, status, elapsedMs: Date.now() - started }));
    }
  }
  private authorizationFetcher(signal: AbortSignal): typeof fetch {
    return (input, init) => {
      signal.throwIfAborted();
      const requested = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return this.authorizationFetch(input, { ...init, signal: requested ? AbortSignal.any([requested, signal]) : signal });
    };
  }
  async prepare(): Promise<void> {
    try {
      const info = await discoverOAuthServerInfo(config.serverUrl, { resourceMetadataUrl, fetchFn: this.authorizationFetcher(AbortSignal.timeout(20000)) });
      if (!info.authorizationServerMetadata || !info.resourceMetadata) this.metadata.clear();
    } catch { this.metadata.clear(); }
  }
  private async authenticate(authorizationCode?: string): Promise<Awaited<ReturnType<typeof auth>>> {
    this.authenticationPending++;
    const signal = AbortSignal.timeout(20000);
    const fetchFn = this.authorizationFetcher(signal);
    try {
      // Do not silently produce a resource-less URL if discovery is unavailable.
      await discoverOAuthProtectedResourceMetadata(config.serverUrl, { resourceMetadataUrl }, fetchFn);
      const result = await auth(this, { serverUrl: config.serverUrl, resourceMetadataUrl, authorizationCode, scope: 'mcp.read', fetchFn });
      // A late code exchange has already saved its tokens; only a late redirect is stale.
      if (result !== 'AUTHORIZED') signal.throwIfAborted();
      return result;
    } catch (error) { this.metadata.clear(); throw error; }
    finally { this.authenticationPending--; }
  }
  refreshTokens(trigger: 'expiry' | 'http_401' = 'expiry', rejectedAccessToken?: string): Promise<'AUTHORIZED'> {
    // A delayed 401 for an older token must not rotate a newer token again.
    const current = this.tokens()?.access_token;
    if (!this.refreshPending && rejectedAccessToken && current && current !== rejectedAccessToken) return Promise.resolve('AUTHORIZED');
    this.refreshPending ??= this.refresh(trigger).finally(() => { this.refreshPending = undefined; });
    return this.refreshPending;
  }
  // Resolves once no rotation is in flight, so its replacement token is saved before exit or login.
  async settled(): Promise<void> { await this.refreshPending?.catch(() => undefined); }
  private async refresh(trigger: 'expiry' | 'http_401'): Promise<'AUTHORIZED'> {
    const clientInformation = this.clientInformation(), refreshToken = this.tokens()?.refresh_token;
    if (!clientInformation || !refreshToken) {
      this.markLoginRequired();
      console.info(JSON.stringify({ event: 'ibkr_token_refresh', trigger, outcome: 'failed', reason: !clientInformation ? 'missing_client' : 'missing_refresh_token', requiresLogin: true }));
      throw new IbkrLoginRequiredError();
    }
    const started = Date.now();
    // Background renewal gets a longer deadline than preparing a browser login.
    // Each HTTP request still has the shared 45-second network limit, except
    // that a sent token exchange always runs to completion (see exchangeToken).
    const fetchFn = this.authorizationFetcher(AbortSignal.timeout(60000));
    try {
      const info = await discoverOAuthServerInfo(config.serverUrl, { resourceMetadataUrl, fetchFn });
      if (!info.resourceMetadata || !info.authorizationServerMetadata) throw new Error('IB 授权元数据暂不可用');
      await selectResourceURL(config.serverUrl, this, info.resourceMetadata);
      // The full auth() flow starts a new browser login after network/server
      // failures. A background refresh must leave those credentials untouched.
      const tokens = await refreshAuthorization(info.authorizationServerUrl, {
        metadata: info.authorizationServerMetadata, clientInformation, refreshToken,
        resource: info.resourceMetadata.resource, fetchFn,
      });
      this.saveTokens(tokens);
      console.info(JSON.stringify({ event: 'ibkr_token_refresh', trigger, outcome: 'success', elapsedMs: Date.now() - started }));
      return 'AUTHORIZED';
    } catch (error) {
      // A failed connection does not invalidate successful, unexpired discovery.
      if (error instanceof OAuthError && !['server_error', 'temporarily_unavailable'].includes(error.errorCode)) this.metadata.clear();
      const requiresLogin = error instanceof InvalidGrantError || error instanceof InvalidClientError || error instanceof UnauthorizedClientError;
      if (requiresLogin) {
        this.invalidateCredentials(error instanceof InvalidGrantError ? 'tokens' : 'all');
        this.markLoginRequired();
      }
      // SDK error descriptions can contain credentials. Log only the parsed
      // error class's standard code, never the response body or error message.
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : readFailureReason(error);
      console.info(JSON.stringify({ event: 'ibkr_token_refresh', trigger, outcome: 'failed', reason, requiresLogin, elapsedMs: Date.now() - started }));
      throw error;
    }
  }
  readonly mcpFetch: typeof fetch = async (input, init) => {
    const address = new URL(input instanceof Request ? input.url : String(input));
    if (address.href !== config.serverUrl) throw new Error('拒绝非 IB MCP 接口');
    const signal = init?.signal ?? (input instanceof Request ? input.signal : new AbortController().signal);
    signal.throwIfAborted();
    if (this.refreshPending) await waitFor(this.refreshPending, signal);
    let token = this.tokens()?.access_token;
    if (!token) throw new IbkrLoginRequiredError();
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('Authorization', `Bearer ${token}`);
      const response = await restrictedFetch(input instanceof Request ? input.clone() : input, { ...init, headers, signal });
      if (response.status !== 401 && response.status !== 403) {
        if (response.ok && this.tokens()?.access_token === token) this.markAuthorized();
        return response;
      }
      console.info(JSON.stringify({ event: 'ibkr_mcp_auth', status: response.status, stage: attempt ? 'retry_rejected' : 'access_rejected' }));
      // Never upscope on 403, and never loop if a fresh token is also rejected.
      if (response.status !== 401 || attempt) {
        if (response.status === 401 && this.tokens()?.access_token === token) this.markLoginRequired();
        return response;
      }
      await response.body?.cancel();
      signal.throwIfAborted();
      // A reader's cancellation must not discard a rotating refresh token.
      await waitFor(this.refreshTokens('http_401', token), signal);
      token = this.tokens()?.access_token;
      if (!token) throw new IbkrLoginRequiredError();
    }
  };
  get redirectUrl(): string { return new URL('/auth/ibkr/callback', config.publicUrl).href; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'IBKR Read-only Dashboard', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp.read' };
  }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.vault.get().oauth?.client; }
  saveClientInformation(client: OAuthClientInformationMixed): void { this.vault.update(value => { (value.oauth ??= {}).client = client; }); }
  tokens(): OAuthTokens | undefined {
    const tokens = this.vault.get().oauth?.tokens;
    if (tokens) validateReadScope(tokens.scope);
    return tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    const existing = this.vault.get().oauth?.tokens;
    const normalized = { ...tokens, refresh_token: tokens.refresh_token ?? existing?.refresh_token, scope: tokens.scope ?? existing?.scope ?? 'mcp.read' };
    validateReadScope(normalized.scope);
    this.vault.update(value => {
      (value.oauth ??= {}).tokens = normalized;
      value.oauth.expiresAt = normalized.expires_in ? Date.now() + normalized.expires_in * 1000 : undefined;
    });
  }
  state(): string {
    const state = randomBytes(32).toString('base64url');
    this.vault.update(value => { (value.oauth ??= {}).state = state; value.oauth.stateExpiresAt = Date.now() + 600000; });
    return state;
  }
  redirectToAuthorization(address: URL): void {
    validateReadScope(address.searchParams.get('scope') ?? undefined);
    if (address.origin !== 'https://api.ibkr.com') throw new Error('拒绝未知授权域名');
    this.vault.update(value => { (value.oauth ??= {}).authorizationUrl = address.href; });
  }
  saveCodeVerifier(verifier: string): void { this.vault.update(value => { (value.oauth ??= {}).verifier = verifier; }); }
  codeVerifier(): string {
    const verifier = this.vault.get().oauth?.verifier;
    if (!verifier) throw new Error('授权验证信息已失效');
    return verifier;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'discovery') this.metadata.clear();
    this.vault.update(value => {
      if (scope === 'all') value.oauth = {};
      if (!value.oauth) return;
      if (scope === 'client') delete value.oauth.client;
      if (scope === 'tokens') { delete value.oauth.tokens; delete value.oauth.expiresAt; }
      if (scope === 'verifier') delete value.oauth.verifier;
    });
  }
  async begin(): Promise<string> {
    await this.settled();
    const client = this.clientInformation();
    const reusable = client && 'redirect_uris' in client && client.redirect_uris?.includes(this.redirectUrl) &&
      (!client.scope || client.scope.split(/\s+/).includes('mcp.read')) && (!client.client_secret_expires_at || client.client_secret_expires_at * 1000 > Date.now());
    this.vault.update(value => {
      const loginRequired = value.oauth?.loginRequired;
      value.oauth = { ...(reusable ? { client } : {}), ...(loginRequired ? { loginRequired } : {}) };
    });
    await this.authenticate();
    const address = this.vault.get().oauth?.authorizationUrl;
    if (!address) throw new Error('IB 未返回授权链接');
    return address;
  }
  async complete(code: string, state: string): Promise<void> {
    const saved = this.vault.get().oauth;
    const expected = saved?.state ?? '';
    if (!expected || !saved?.stateExpiresAt || Date.now() > saved.stateExpiresAt || Buffer.byteLength(state) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) throw new Error('授权校验失败或已过期');
    this.vault.update(value => { if (value.oauth) { delete value.oauth.state; delete value.oauth.stateExpiresAt; } });
    const result = await this.authenticate(code);
    if (result !== 'AUTHORIZED' || !this.tokens()?.access_token) throw new Error('IB 未完成只读授权');
    this.markAuthorized();
    this.vault.update(value => { if (value.oauth) { delete value.oauth.verifier; delete value.oauth.authorizationUrl; } });
  }
}

export function decodeToolResult(result: unknown): unknown {
  const response = result as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
  if (response.isError) throw new Error('IB 工具返回错误，未更新数据');
  if (response.structuredContent !== undefined) return response.structuredContent;
  const text = response.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
  if (!text) throw new Error('IB 未返回可解析的数据');
  return JSON.parse(text);
}

export type AccountReadPhase = 'connecting' | 'positions' | 'summary' | 'balances';
export interface AccountRead {
  positions: unknown; summary: unknown; balances: unknown;
  sources: { positions: string; summary: string; balances: string };
}

export class IbkrClient {
  private client?: Client;
  private readonly queue = new ReadQueue();
  constructor(readonly oauth: IbkrOAuth) {}

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }

  private async connect(signal: AbortSignal): Promise<Client> {
    signal.throwIfAborted();
    if (!this.oauth.tokens()) throw new IbkrLoginRequiredError();
    const expiry = this.oauth.vault.get().oauth?.expiresAt;
    if (expiry && expiry < Date.now() + 60000) {
      await this.disconnect();
      const refreshed = await waitFor(this.oauth.refreshTokens(), signal);
      if (refreshed !== 'AUTHORIZED') throw new Error('IB 授权需要重新登录');
    }
    if (this.client) return this.client;
    let initializing: AbortSignal | undefined = signal;
    // The SDK's authProvider starts browser authorization on some refresh failures.
    // Route POSTs and SSE reconnects through our single background renewal path.
    const transport = new StreamableHTTPClientTransport(new URL(config.serverUrl), {
      fetch: (input, init) => this.oauth.mcpFetch(input, initializing ? { ...init, signal: AbortSignal.any([initializing, ...(init?.signal ? [init.signal] : [])]) } : init) });
    const client = new Client({ name: 'ibkr-read-only-dashboard', version: '0.1.0' });
    try {
      await client.connect(transport, { signal, timeout: 45000 });
      signal.throwIfAborted();
      this.client = client;
      return client;
    } catch (error) { await client.close().catch(() => undefined); throw error; }
    finally { initializing = undefined; }
  }

  private async invoke(name: string, argumentsValue: Record<string, unknown>, signal: AbortSignal, queueMs = 0, ready?: () => void): Promise<unknown> {
    const started = Date.now();
    let outcome = 'success', reason: string | undefined;
    try {
      const client = await this.connect(signal);
      signal.throwIfAborted(); ready?.();
      const result = await client.callTool({ name, arguments: argumentsValue }, undefined, { timeout: 45000, signal });
      signal.throwIfAborted();
      return decodeToolResult(result);
    } catch (error) {
      outcome = 'failed'; reason = readFailureReason(error);
      await this.disconnect();
      throw error;
    } finally {
      console.info(JSON.stringify({ event: 'ibkr_read', tool: name, outcome, reason, queueMs, elapsedMs: Date.now() - started }));
    }
  }
  call(name: string, argumentsValue: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (!READ_TOOLS.has(name)) return Promise.reject(new Error('工具不在只读白名单中'));
    const queuedAt = Date.now(), timeout = AbortSignal.timeout(90000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return this.queue.run(() => this.invoke(name, argumentsValue, signal, Date.now() - queuedAt), signal);
  }
  readAccount(progress: (phase: AccountReadPhase) => void = () => {}, requested?: AbortSignal): Promise<AccountRead> {
    const queuedAt = Date.now(), timeout = AbortSignal.timeout(120000);
    const signal = requested ? AbortSignal.any([requested, timeout]) : timeout;
    return this.queue.run(async () => {
      const result = { sources: {} } as AccountRead;
      for (const phase of ['positions', 'summary', 'balances'] as const) {
        progress('connecting');
        result[phase] = await this.invoke('get_account_' + phase, {}, signal, phase === 'positions' ? Date.now() - queuedAt : 0, () => progress(phase));
        result.sources[phase] = new Date().toISOString();
      }
      return result;
    }, signal, true);
  }
}
