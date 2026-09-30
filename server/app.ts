import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { config } from './config.js';
import type { Collector } from './collector.js';
import type { IbkrClient } from './ibkr.js';
import { createAccessPolicy, isDirectLocalRequest, type AccessSettings } from './access.js';
import type { DiscordControls } from './discord/index.js';

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
export function createApp(client: IbkrClient, collector: Collector, accessSettings: AccessSettings = config, integrations: () => unknown = () => ({ enabled: false }), controls?: IntegrationControls, discord?: DiscordControls) {
  const app = express();
  const vault = client.oauth.vault;
  const sessions = new Map<string, Session>();
  const issuedSessions = new WeakMap<Request, string>();
  const attempts = new Map<string, { count: number; until: number }>();
  const streamCounts = new Map<string, number>();
  const access = createAccessPolicy(accessSettings);
  const secure = access.secure;
  const cookieName = secure ? '__Host-ibkr_session' : 'ibkr_session';
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
    if (access.localAccess && !isDirectLocalRequest(access, {
      remoteAddress: request.socket.remoteAddress,
      host: request.headers.host,
      origin: request.headers.origin,
      fetchSite: typeof request.headers['sec-fetch-site'] === 'string' ? request.headers['sec-fetch-site'] : undefined,
      apiRequest: request.path.startsWith('/api/'),
      forwarded: Object.keys(request.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip'),
    })) {
      response.status(403).json({ error: '本机免密模式只允许直接访问本机地址，不接受外部站点或代理请求' });
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !access.origins.has(request.headers.origin ?? '')) {
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
    if (!sessionFor(request) && access.localAccess && request.method === 'GET') issueSession(request, response);
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
  app.get('/api/session', (request, response) => {
    const session = sessionFor(request) ?? (access.localAccess ? issueSession(request, response) : undefined);
    response.json({ authenticated: Boolean(session), csrf: session?.csrf ?? null, accessMode: access.localAccess ? 'local' : 'password' });
  });
  app.use(['/api/login', '/api/logout', '/api/password'], (_request, response, next) => {
    if (access.localAccess) { response.status(404).json({ error: '本机免密模式无需看板密码' }); return; }
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
  app.get('/api/discord', requireSession, (_request, response) => {
    if (!discord) { response.status(404).json({ error: 'Discord 尚未配置' }); return; }
    response.json(discord.status());
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
    try {
      await collector.pause();
      const url = await client.oauth.begin();
      const session = sessionFor(request);
      if (!session) { response.status(401).json({ error: '会话已过期，请重新登录' }); return; }
      session.oauthState = new URL(url).searchParams.get('state') ?? undefined;
      response.json({ url });
    } catch {
      response.status(502).json({ error: '无法创建 IB 授权，请检查服务器网络与地区可用性。' });
    } finally {
      authorizing = false;
      collector.start();
    }
  });
  app.get('/auth/ibkr/callback', requireSession, async (request, response) => {
    const session = sessionFor(request)!;
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    if (!state || !session.oauthState || !equal(state, session.oauthState) || !code) {
      response.redirect('/?connection=failed');
      return;
    }
    delete session.oauthState;
    try {
      await collector.pause();
      await client.oauth.complete(code, state);
      response.redirect('/?connection=success');
    } catch { response.redirect('/?connection=failed'); }
    finally { collector.start(); }
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
