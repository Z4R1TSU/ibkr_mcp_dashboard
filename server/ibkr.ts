import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from './config.js';
import { Vault } from './vault.js';

export const READ_TOOLS = new Set(['get_account_positions', 'get_account_summary', 'get_account_balances', 'get_price_snapshot', 'get_pa_allocation', 'get_pa_performance_all_periods', 'get_account_trades', 'search_contracts', 'get_price_history']);

export function validateReadScope(scope: string | undefined): void {
  if (scope?.trim() !== 'mcp.read') throw new Error('拒绝非 mcp.read 授权');
}

const restrictedFetch: typeof fetch = async (input, init) => {
  const address = new URL(input instanceof Request ? input.url : String(input));
  if (address.origin !== 'https://api.ibkr.com') throw new Error('拒绝非 IB 官方接口');
  const requestedSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const timeout = AbortSignal.timeout(45000);
  return fetch(input, { ...init, redirect: 'error', signal: requestedSignal ? AbortSignal.any([requestedSignal, timeout]) : timeout });
};

export class IbkrOAuth implements OAuthClientProvider {
  constructor(readonly vault: Vault) {}
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
    this.vault.update(value => {
      if (scope === 'all') value.oauth = {};
      if (!value.oauth) return;
      if (scope === 'client') delete value.oauth.client;
      if (scope === 'tokens') delete value.oauth.tokens;
      if (scope === 'verifier') delete value.oauth.verifier;
    });
  }
  async begin(): Promise<string> {
    this.vault.update(value => { value.oauth = {}; });
    await auth(this, { serverUrl: config.serverUrl, scope: 'mcp.read', fetchFn: restrictedFetch });
    const address = this.vault.get().oauth?.authorizationUrl;
    if (!address) throw new Error('IB 未返回授权链接');
    return address;
  }
  async complete(code: string, state: string): Promise<void> {
    const saved = this.vault.get().oauth;
    const expected = saved?.state ?? '';
    if (!expected || !saved?.stateExpiresAt || Date.now() > saved.stateExpiresAt || Buffer.byteLength(state) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) throw new Error('授权校验失败或已过期');
    this.vault.update(value => { if (value.oauth) { delete value.oauth.state; delete value.oauth.stateExpiresAt; } });
    await auth(this, { serverUrl: config.serverUrl, authorizationCode: code, scope: 'mcp.read', fetchFn: restrictedFetch });
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

export class IbkrClient {
  private client?: Client;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly oauth: IbkrOAuth) {}

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }

  private async connect(): Promise<Client> {
    if (!this.oauth.tokens()) throw new Error('需要 IB 只读授权');
    const expiry = this.oauth.vault.get().oauth?.expiresAt;
    if (expiry && expiry < Date.now() + 60000) {
      await this.disconnect();
      const refreshed = await auth(this.oauth, { serverUrl: config.serverUrl, scope: 'mcp.read', fetchFn: restrictedFetch });
      if (refreshed !== 'AUTHORIZED') throw new Error('IB 授权需要重新登录');
    }
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(config.serverUrl), { authProvider: this.oauth, fetch: restrictedFetch });
    const client = new Client({ name: 'ibkr-read-only-dashboard', version: '0.1.0' });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async call(name: string, argumentsValue: Record<string, unknown> = {}): Promise<unknown> {
    if (!READ_TOOLS.has(name)) throw new Error('工具不在只读白名单中');
    const operation = this.pending.catch(() => undefined).then(async () => {
      try {
        const client = await this.connect();
        return decodeToolResult(await client.callTool({ name, arguments: argumentsValue }, undefined, { timeout: 45000 }));
      } catch (error) {
        await this.disconnect();
        throw error;
      }
    });
    this.pending = operation;
    return operation;
  }
}
