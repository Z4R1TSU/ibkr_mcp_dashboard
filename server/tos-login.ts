import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';

export function createTosLoginBridge(directory: string, session: (request: Request) => string) {
  let owner: string | null = null, ownerUntil = 0;
  return async (request: Request, response: Response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    const allowed = request.method === 'GET' ? ['/', '/app.js', '/status', '/frame']
      : request.method === 'POST' ? ['/start', '/stop', '/input', '/credentials', '/factor', '/code'] : [];
    if (!allowed.includes(route)) { response.status(404).end(); return; }
    const current = session(request);
    if (Date.now() > ownerUntil) owner = null;
    if (['/start', '/credentials'].includes(route) && (!owner || owner === current)) {
      owner = current; ownerUntil = Date.now() + 31 * 60 * 1000;
    }
    if (['/frame', '/input', '/start', '/stop', '/credentials', '/factor', '/code'].includes(route) && owner !== current) {
      response.status(409).json({ error: '登录窗口由另一会话使用或尚未打开' }); return;
    }
    try {
      const file = path.join(directory, 'login-key.json'), st = fs.lstatSync(file);
      if (!st.isFile() || (st.mode & 0o077) || st.uid !== process.getuid?.()) throw new Error('permissions');
      const key = JSON.parse(fs.readFileSync(file, 'utf8')).key;
      if (typeof key !== 'string') throw new Error('key');
      const upstream = await fetch('http://127.0.0.1:8052' + route, {
        method: request.method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: request.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > 2 * 1024 * 1024) throw new Error('size');
      response.status(upstream.status).type(upstream.headers.get('Content-Type') || 'application/json').send(body);
      if (route === '/stop' && upstream.ok) owner = null;
    } catch {
      response.status(503).json({ error: 'thinkorswim 登录服务暂不可用' });
    }
  };
}
