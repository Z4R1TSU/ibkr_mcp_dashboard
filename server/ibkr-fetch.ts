import 'dotenv/config';
import { Agent, ProxyAgent } from 'undici';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export class IbkrLoginRequiredError extends Error {
  constructor() { super('需要 IB 只读授权'); }
}
export class IbkrResponseLostError extends Error {
  constructor(readonly status: number | null, cause: unknown) { super('IB 令牌交换结果未完整接收', { cause }); }
}

export function ibkrDispatcher(proxy?: string): Agent | ProxyAgent {
  const options = { connectTimeout: 30000, autoSelectFamily: true, headersTimeout: 0, bodyTimeout: 0 };
  if (!proxy?.trim()) return new Agent(options);
  let address: URL;
  try { address = new URL(proxy); } catch { throw new Error('IBKR_HTTP_PROXY 地址无效'); }
  if (!['http:', 'https:'].includes(address.protocol)) throw new Error('IBKR_HTTP_PROXY 必须使用 HTTP 或 HTTPS');
  // ProxyAgent builds its own connectors; top-level connectTimeout is ignored.
  const tls = { timeout: options.connectTimeout, autoSelectFamily: true };
  return new ProxyAgent({ ...options, uri: proxy, proxyTls: tls, requestTls: tls });
}
const dispatcher = ibkrDispatcher(process.env.IBKR_HTTP_PROXY);
// undici reports a non-200 answer to CONNECT as an aborted request. The tunnel
// never opened, so IB received nothing: as safe to retry as a refused connect.
// The same code can mark other aborts, so the message must match as well.
function tunnelRefused(value: { code?: string; message?: unknown }): boolean {
  return value.code === 'UND_ERR_ABORTED' && typeof value.message === 'string' && /^Proxy response \(\d{3}\) !== 200 when HTTP Tunneling$/.test(value.message);
}
function proxyTunnelFailure(error: unknown): boolean {
  const value = error as { code?: string; message?: unknown; cause?: unknown } | null;
  return !!value && (tunnelRefused(value) || proxyTunnelFailure(value.cause));
}
export function connectionFailure(error: unknown): boolean {
  const value = error as { code?: string; message?: unknown; syscall?: string; errors?: unknown[]; cause?: unknown } | null;
  if (!value) return false;
  if (Array.isArray(value.errors) && value.errors.length) return value.errors.every(connectionFailure);
  if (['UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(value.code ?? '') || tunnelRefused(value)) return true;
  if (value.syscall === 'connect' && ['ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(value.code ?? '')) return true;
  return value.cause ? connectionFailure(value.cause) : false;
}
export function readFailureReason(error: unknown): string {
  if (error instanceof IbkrLoginRequiredError) return 'authorization_required';
  if (error instanceof IbkrResponseLostError) return 'response_lost';
  if (error instanceof OAuthError) return error.errorCode;
  if (error instanceof StreamableHTTPError && typeof error.code === 'number' && Number.isInteger(error.code) && error.code >= 100 && error.code <= 599) return `http_${error.code}`;
  if (proxyTunnelFailure(error)) return 'proxy_tunnel_failed';
  if (connectionFailure(error)) return 'connection_failed';
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'deadline';
  return 'request_failed';
}

async function send(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, signal: AbortSignal, connection = dispatcher): Promise<Response> {
  const address = new URL(input instanceof Request ? input.url : String(input));
  if (address.origin !== 'https://api.ibkr.com') throw new Error('拒绝非 IB 官方接口');
  const replayable = !(input instanceof Request) && (!init?.body || typeof init.body === 'string' || init.body instanceof URLSearchParams);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const options: RequestInit & { dispatcher: Agent | ProxyAgent } = { ...init, dispatcher: connection, redirect: 'error', signal };
      return await fetch(input, options);
    } catch (error) {
      // Retry only failures before a connection exists; never replay a lost token response.
      if (attempt || !replayable || signal.aborted || !connectionFailure(error)) throw error;
      console.info(JSON.stringify({ event: 'ibkr_connection_retry', path: address.pathname }));
    }
  }
}

export const restrictedFetch: typeof fetch = async (input, init) => {
  const requested = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const timeout = AbortSignal.timeout(45000);
  return send(input, init, requested ? AbortSignal.any([requested, timeout]) : timeout);
};

export const TOKEN_EXCHANGE_MS = 300000;
// IB revokes the previous refresh token as soon as it answers, so a token
// response is the only copy of its replacement. Abandoning a sent exchange can
// only lose it: caller deadlines are ignored, and the body is read here under
// the exchange's own limit before anyone else sees the response.
export async function exchangeToken(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, limitMs = TOKEN_EXCHANGE_MS): Promise<Response> {
  const address = new URL(input instanceof Request ? input.url : String(input));
  if (address.origin !== 'https://api.ibkr.com') throw new Error('拒绝非 IB 官方接口');
  // One-use grants get a fresh connection, isolated from data/SSE traffic.
  // Select the route before sending; never switch routes after an uncertain result.
  const proxy = process.env.IBKR_TOKEN_HTTP_PROXY ?? process.env.IBKR_HTTP_PROXY;
  const connection = ibkrDispatcher(proxy);
  const started = Date.now();
  let status: number | null = null, headersMs: number | null = null, receivedBytes = 0;
  let phase: 'headers' | 'body' | 'complete' = 'headers', reason: string | undefined;
  try {
    const response = await send(input, { ...init, signal: undefined }, AbortSignal.timeout(limitMs), connection);
    status = response.status; headersMs = Date.now() - started; phase = 'body';
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); receivedBytes += value.byteLength;
        }
      } finally { reader.releaseLock(); }
    }
    const complete = new Response(Buffer.concat(chunks), { status, statusText: response.statusText, headers: response.headers });
    phase = 'complete';
    return complete;
  } catch (error) {
    reason = readFailureReason(error);
    // A timeout without headers can still mean IB consumed the grant.
    if (status === null && connectionFailure(error)) throw error;
    throw new IbkrResponseLostError(status, error);
  } finally {
    console.info(JSON.stringify({ event: 'ibkr_token_exchange', route: proxy?.trim() ? 'proxy' : 'direct', phase, status, headersMs, receivedBytes, elapsedMs: Date.now() - started, reason }));
    await connection.destroy().catch(() => undefined);
  }
}
