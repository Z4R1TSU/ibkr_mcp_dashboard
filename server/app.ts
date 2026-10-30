import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { config } from './config.js';
import type { Collector } from './collector.js';
import type { IbkrClient } from './ibkr.js';
import { createAccessPolicy, isDirectLocalRequest, isTrustedIntranetRequest, type AccessSettings } from './access.js';
import type { DiscordControls } from './discord/index.js';
import { TradeHistory } from './trades.js';
import { inferCashFlows, withCashFlows } from './cash-flows.js';
import { isTradeRange } from '../shared/trades.js';
import { isCalendarMonth } from '../shared/pnl-calendar.js';
import type { PerformanceSource } from './performance-source.js';
import { newYorkDate } from './daily-performance.js';
import { createTosLoginBridge } from './tos-login.js';

interface Session { csrf: string; expires: number; oauthState?: string }
export interface IntegrationControls {
  groups(input: unknown): void;
  chats(): Promise<unknown>;
  members(chatId: string): Promise<unknown>;
  daily?(input: unknown): void;
  report?(): Promise<string>;
}
function equal(first: string, second: string): boolean {
  return Buffer.byteLength(first) === Buffer.byteLength(second) && timingSafeEqual(Buffer.from(first), Buffer.from(second));
}
export function createApp(client: IbkrClient, collector: Collector, accessSettings: AccessSettings = config, integrations: () => unknown = () => ({ enabled: false }), controls?: IntegrationControls, discord?: DiscordControls, performance?: Pick<PerformanceSource, 'calendar'>) {
  const app = express();
  const vault = client.oauth.vault;
  const trades = new TradeHistory(client, vault.directory);
  const sessions = new Map<string, Session>();
  const issuedSessions = new WeakMap<Request, string>();
  const attempts = new Map<string, { count: number; until: number }>();
  const streamCounts = new Map<string, number>();
  const access = createAccessPolicy(accessSettings);
  const secure = access.secure;
  // Browsers share cookies across ports; isolate each dashboard origin.
  const cookieName = (secure ? '__Host-ibkr_session_' : 'ibkr_session_') + createHash('sha256').update(access.origin).digest('hex').slice(0, 12);
  const logAuthorization = (stage: string, timing: { elapsedMs?: number; collectorWaitMs?: number } = {}) => console.info(JSON.stringify({ event: 'ibkr_authorization', stage, time: new Date().toISOString(), ...timing }));
  let lastRefresh = 0;
  let authorizing = false;
  const sessionId = (request: Request) => issuedSessions.get(request) ?? request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
  const sessionFor = (request: Request): Session | undefined => {
    const id = sessionId(request);
    const session = sessions.get(id);
    if (session && session.expires > Date.now()) return session;
    sessions.delete(id);
    return undefined;
  };
  const issueSession = (request: Request, response: Response): Session => {
    for (const [id, session] of sessions) if (session.expires < Date.now()) sessions.delete(id);
    sessions.delete(sessionId(request));
    if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
    const id = randomBytes(32).toString('base64url');
    const session = { csrf: randomBytes(32).toString('base64url'), expires: Date.now() + config.sessionHours * 3600000 };
    sessions.set(id, session);
    issuedSessions.set(request, id);
    response.cookie(cookieName, id, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: config.sessionHours * 3600000 });
    return session;
  };
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    });
    if (secure) response.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use((request, response, next) => {
    const peer = {
      remoteAddress: request.socket.remoteAddress,
      host: request.headers.host,
      origin: request.headers.origin,
      fetchSite: typeof request.headers['sec-fetch-site'] === 'string' ? request.headers['sec-fetch-site'] : undefined,
      apiRequest: request.path.startsWith('/api/'),
      forwarded: Object.keys(request.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip'),
      gatewayToken: typeof request.headers['x-ibkr-intranet-gateway'] === 'string' ? request.headers['x-ibkr-intranet-gateway'] : undefined,
    };
    if (access.localAccess && !isDirectLocalRequest(access, peer) ||
        access.intranetAccess && request.path !== '/api/health' && !isTrustedIntranetRequest(access, peer)) {
      response.status(403).json({ error: '当前免密入口不接受此访问来源' });
      return;
    }
    const syncAuthorization = discord?.remote?.authorized(request.headers.authorization);
    const syncRoute = request.method === 'GET' && request.path === '/api/discord/remote'
      || request.method === 'POST' && request.path === '/api/discord/remote/status';
    if (syncAuthorization && !syncRoute) {
      response.status(401).json({ error: '同步令牌仅允许读取摘要和回报状态' });
      return;
    }
    const authenticatedSync = request.path === '/api/discord/remote/status' && syncAuthorization;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !access.origins.has(request.headers.origin ?? '') && !authenticatedSync) {
      response.status(403).json({ error: '请求来源不匹配' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '8kb', strict: true }));
  app.get('/', (request, response, next) => {
    if (access.localAccess && request.headers.host?.toLowerCase() !== new URL(access.origin).host) {
      response.redirect(302, access.origin + request.originalUrl);
      return;
    }
    next();
  });
  const requireSession = (request: Request, response: Response, next: NextFunction) => {
    if (!sessionFor(request) && access.passwordless && request.method === 'GET') issueSession(request, response);
    if (!sessionFor(request)) { response.status(401).json({ error: '请先登录看板' }); return; }
    next();
  };
  const requireCsrf = (request: Request, response: Response, next: NextFunction) => {
    const session = sessionFor(request);
    const csrf = request.headers['x-csrf-token'];
    if (!session || typeof csrf !== 'string' || !equal(csrf, session.csrf)) { response.status(403).json({ error: '请求校验失败，请重新登录' }); return; }
    next();
  };
  app.get('/api/health', (_request, response) => { response.json({ ok: true }); });
  const tosLogin = createTosLoginBridge(path.resolve(process.env.TOS_DATA_DIR || path.join(config.dataDir, 'thinkorswim')), sessionId);
  app.use('/tos-login', requireSession, (request, response, next) => {
    if (request.method === 'GET') next();
    else requireCsrf(request, response, next);
  }, tosLogin);
  app.get('/api/session', (request, response) => {
    const session = sessionFor(request) ?? (access.passwordless ? issueSession(request, response) : undefined);
    response.json({ authenticated: Boolean(session), csrf: session?.csrf ?? null, accessMode: accessSettings.accessMode });
  });
  app.use(['/api/login', '/api/logout', '/api/password'], (_request, response, next) => {
    if (access.passwordless) { response.status(404).json({ error: '当前免密模式无需看板密码' }); return; }
    next();
  });
  app.post('/api/login', (request, response) => {
    const key = request.ip ?? 'unknown';
    for (const [address, attempt] of attempts) if (attempt.until < Date.now()) attempts.delete(address);
    const attempt = attempts.get(key) ?? { count: 0, until: Date.now() + 15 * 60000 };
    attempts.set(key, attempt);
    attempt.count += 1;
    if (attempt.count > 10 || attempts.size > 1000) { response.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' }); return; }
    if (!vault.checkPassword(request.body?.password)) { response.status(401).json({ error: '密码不正确' }); return; }
    attempts.delete(key);
    const session = issueSession(request, response);
    response.json({ authenticated: true, csrf: session.csrf });
  });
  app.post('/api/logout', requireSession, requireCsrf, (request, response) => {
    sessions.delete(sessionId(request));
    response.clearCookie(cookieName, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
    response.json({ ok: true });
  });
  app.post('/api/password', requireSession, requireCsrf, (request, response) => {
    if (!vault.checkPassword(request.body?.currentPassword)) { response.status(401).json({ error: '当前密码不正确' }); return; }
    if (typeof request.body?.password !== 'string' || request.body.password.length < 12 || request.body.password.length > 256) { response.status(400).json({ error: '新密码须为 12–256 个字符' }); return; }
    vault.setPassword(request.body.password);
    fs.rmSync(path.join(vault.directory, 'initial-password.txt'), { force: true });
    sessions.clear();
    response.clearCookie(cookieName, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
    response.json({ ok: true });
  });
  app.get('/api/portfolio', requireSession, (_request, response) => { response.json(collector.view()); });
  const cashFlows = () => {
    if (!authorizing) trades.read('year');
    return inferCashFlows(trades.yearHistory());
  };
  app.get('/api/cash-flows', requireSession, (_request, response) => { response.json(cashFlows()); });
  app.post('/api/cash-flows/refresh', requireSession, requireCsrf, (_request, response) => {
    if (authorizing) { response.status(409).json({ error: '正在建立授权，请稍候' }); return; }
    void trades.refresh(true, 'year');
    response.status(202).json(inferCashFlows(trades.yearHistory()));
  });
  app.get('/api/pnl-calendar', requireSession, (request, response) => {
    const now = new Date();
    const currentMonth = newYorkDate(now).date.slice(0, 7);
    const month = request.query.month ?? currentMonth;
    if (!isCalendarMonth(month) || month > currentMonth) {
      response.status(400).json({ error: '请选择有效月份，不能晚于本月' }); return;
    }
    if (!performance) { response.status(503).json({ error: '盈亏历史暂不可用' }); return; }
    response.json(withCashFlows(performance.calendar(month, now), cashFlows()));
  });
  app.get('/api/trades', requireSession, (request, response) => {
    const range = request.query.range ?? 'previous';
    if (!isTradeRange(range)) { response.status(400).json({ error: '无效的交易时间范围' }); return; }
    response.json(authorizing ? trades.view(range) : trades.read(range));
  });
  app.post('/api/trades/refresh', requireSession, requireCsrf, (request, response) => {
    if (authorizing) { response.status(409).json({ error: '正在建立授权，请稍候' }); return; }
    const range = request.query.range ?? 'previous';
    if (!isTradeRange(range)) { response.status(400).json({ error: '无效的交易时间范围' }); return; }
    void trades.refresh(true, range);
    response.status(202).json(trades.view(range));
  });
  const requireDiscordSync = (request: Request, response: Response, next: NextFunction) => {
    if (!discord?.remote) { response.status(404).json({ error: 'Mac 同步尚未启用' }); return; }
    if (!discord.remote.authorized(request.headers.authorization)) { response.status(401).json({ error: 'Mac 同步令牌无效' }); return; }
    next();
  };
  app.get('/api/discord/remote', requireDiscordSync, (_request, response) => {
    response.json(discord!.remote!.payload());
  });
  app.post('/api/discord/remote/status', requireDiscordSync, (request, response) => {
    try { discord!.remote!.report(request.body); response.json({ ok: true }); }
    catch { response.status(400).json({ error: 'Mac 同步状态格式无效' }); }
  });
  app.get('/api/discord', requireSession, (_request, response) => {
    if (!discord) { response.status(404).json({ error: 'Discord 尚未配置' }); return; }
    response.json(discord.status());
  });
  app.get('/api/discord/mac-download', requireSession, (_request, response) => {
    const file = discord?.macPackage();
    if (!file) { response.status(404).json({ error: 'Mac 安装包尚未准备好' }); return; }
    response.download(file, 'discord-mac.tar.gz', error => {
      if (error && !response.headersSent) response.status(500).json({ error: 'Mac 安装包读取失败' });
    });
  });
  app.get('/api/discord/summary', requireSession, (_request, response) => {
    if (!discord) { response.status(404).json({ error: 'Discord 尚未配置' }); return; }
    response.json(discord.status().summary);
  });
  app.get('/api/discord/capital-preview', requireSession, async (_request, response) => {
    if (!discord) { response.status(404).json({ error: 'Discord 尚未配置' }); return; }
    try { response.json(await discord.capitalPreview()); }
    catch { response.status(502).json({ error: '换汇记录暂不可用' }); }
  });
  app.post('/api/discord/preview', requireSession, requireCsrf, async (request, response) => {
    if (!discord) { response.status(404).json({ error: 'Discord 尚未配置' }); return; }
    try { response.json(await discord.preview(request.body?.startDate, request.body?.capitalUsd)); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : '预览失败' }); }
  });
  app.post('/api/discord', requireSession, requireCsrf, async (request, response) => {
    if (!discord) { response.status(404).json({ error: 'Discord 尚未配置' }); return; }
    try { response.json(await discord.update(request.body)); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Discord 设置保存失败' }); }
  });
  app.get('/api/integrations', requireSession, (_request, response) => { response.json(integrations()); });
  app.get('/api/integrations/report', requireSession, async (_request, response) => {
    if (!controls?.report) { response.status(409).json({ error: '日报尚未启用' }); return; }
    try { response.json({ text: await controls.report() }); }
    catch { response.status(502).json({ error: '上一美股交易日数据尚未齐全，请稍后重试。' }); }
  });
  app.get('/api/integrations/chats', requireSession, async (_request, response) => {
    if (!controls) { response.status(409).json({ error: '飞书尚未启用' }); return; }
    try { response.json({ chats: await controls.chats() }); }
    catch { response.status(502).json({ error: '群列表读取失败，请检查飞书应用权限。' }); }
  });
  app.get('/api/integrations/members/:chatId', requireSession, async (request, response) => {
    if (!controls) { response.status(409).json({ error: '飞书尚未启用' }); return; }
    try { response.json(await controls.members(String(request.params.chatId))); }
    catch { response.status(502).json({ error: '成员读取失败，请开通 im:chat.members:read 权限后重试。也可以手动填写成员 open_id。' }); }
  });
  app.post('/api/integrations/groups', requireSession, requireCsrf, (request, response) => {
    if (!controls) { response.status(409).json({ error: '飞书尚未启用' }); return; }
    try { controls.groups(request.body?.groups); response.json({ ok: true }); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : '群配置无效' }); }
  });
  app.post('/api/integrations/daily', requireSession, requireCsrf, (request, response) => {
    if (!controls?.daily) { response.status(409).json({ error: '飞书尚未启用' }); return; }
    try { controls.daily(request.body?.text); response.json({ ok: true }); }
    catch { response.status(400).json({ error: '日报时间无效' }); }
  });
  app.post('/api/refresh', requireSession, requireCsrf, (_request, response) => {
    if (authorizing) { response.status(409).json({ error: '正在建立授权，请稍候' }); return; }
    if (Date.now() - lastRefresh < 30000) { response.status(429).json({ error: '请至少间隔 30 秒再手动刷新' }); return; }
    lastRefresh = Date.now();
    void collector.refresh();
    void trades.refresh(true);
    response.status(202).json({ ok: true });
  });
  app.get('/api/events', requireSession, (request, response) => {
    const id = sessionId(request);
    if ((streamCounts.get(id) ?? 0) >= 4) { response.status(429).end(); return; }
    streamCounts.set(id, (streamCounts.get(id) ?? 0) + 1);
    response.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    const send = () => {
      if (!sessionFor(request)) { response.write('event: expired\ndata: {}\n\n'); response.end(); return; }
      if (response.writableLength > 1024 * 1024) { response.end(); return; }
      response.write(`data: ${JSON.stringify(collector.view())}\n\n`);
    };
    send();
    collector.on('change', send);
    const heartbeat = setInterval(send, 15000);
    response.on('close', () => {
      clearInterval(heartbeat);
      collector.off('change', send);
      const count = (streamCounts.get(id) ?? 1) - 1;
      if (count > 0) streamCounts.set(id, count); else streamCounts.delete(id);
    });
  });
  app.post('/api/ibkr/connect', requireSession, requireCsrf, async (request, response) => {
    if (authorizing) { response.status(409).json({ error: '已有授权请求正在进行' }); return; }
    authorizing = true;
    const started = Date.now();
    let collectorWaitMs: number | undefined;
    logAuthorization('start_requested');
    try {
      await collector.pause();
      collectorWaitMs = Date.now() - started;
      const url = await client.oauth.begin();
      const session = sessionFor(request);
      if (!session) { response.status(401).json({ error: '会话已过期，请重新登录' }); return; }
      session.oauthState = new URL(url).searchParams.get('state') ?? undefined;
      logAuthorization('started', { elapsedMs: Date.now() - started, collectorWaitMs });
      response.json({ url });
    } catch (error) {
      logAuthorization('start_failed', { elapsedMs: Date.now() - started, collectorWaitMs });
      const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      response.status(502).json({ error: timedOut ? 'IB 授权服务响应超时，请稍后重试。' : '无法创建 IB 授权，请检查服务器网络与地区可用性。' });
    } finally {
      authorizing = false;
      collector.start();
    }
  });
  app.get('/auth/ibkr/callback', async (request, response) => {
    const session = sessionFor(request);
    const finish = (outcome: string) => {
      logAuthorization(outcome);
      response.redirect(303, '/?connection=' + outcome);
    };
    if (!session) { finish('session-expired'); return; }
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    if (!state || !session.oauthState || !equal(state, session.oauthState)) { finish('invalid-state'); return; }
    if (authorizing) { finish('busy'); return; }
    delete session.oauthState;
    if (request.query.error) { finish(request.query.error === 'access_denied' ? 'access-denied' : 'ib-error'); return; }
    if (!code) { finish('missing-code'); return; }
    authorizing = true;
    logAuthorization('callback_received');
    try {
      await collector.pause();
      await client.oauth.complete(code, state);
      finish('success');
    } catch { finish('token-exchange-failed'); }
    finally { authorizing = false; collector.start(); }
  });
  app.use('/api', (_request, response) => { response.status(404).json({ error: '接口不存在' }); });
  const clientDirectory = path.resolve('dist/client');
  app.use(express.static(clientDirectory, { etag: false, maxAge: 0 }));
  app.get('/', (_request, response) => { response.sendFile(path.join(clientDirectory, 'index.html')); });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) { response.end(); return; }
    const status = error && typeof error === 'object' && 'status' in error && error.status === 400 ? 400 : 500;
    response.status(status).json({ error: status === 400 ? '请求格式不正确' : '服务暂时不可用' });
  });
  return app;
}
