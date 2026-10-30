import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createServer as httpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { isIntranetPeer, isPrivateIPv4 } from './access.js';

export interface IntranetHttps {
  hostname: string; port: number; certificatePort: number; publicUrl: string;
  certFile: string; keyFile: string; upstreamHost: string; upstreamPort: number;
  gatewayToken?: string;
}

export async function startIntranetHttps(settings: IntranetHttps): Promise<{ close(): Promise<void> }> {
  const cert = fs.readFileSync(settings.certFile), key = fs.readFileSync(settings.keyFile);
  const certificate = new X509Certificate(cert);
  if (certificate.ca || !certificate.checkIP(settings.hostname) || Date.parse(certificate.validTo) <= Date.now()) throw new Error('内网 HTTPS 证书必须是有效且匹配内网 IP 的服务证书');
  const gateway = httpsServer({ cert, key, minVersion: 'TLSv1.2' }, (request, response) => {
    if (settings.gatewayToken && !isIntranetPeer(request.socket.remoteAddress)) { response.writeHead(403).end(); return; }
    const expected = new URL(settings.publicUrl).host;
    if (request.headers.host !== expected || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(400).end(); return;
    }
    const headers: typeof request.headers = { ...request.headers, host: expected };
    for (const name of Object.keys(headers)) if (name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip' || name === 'x-ibkr-intranet-gateway') delete headers[name];
    if (settings.gatewayToken) headers['x-ibkr-intranet-gateway'] = settings.gatewayToken;
    const upstream = httpRequest({
      hostname: settings.upstreamHost, port: settings.upstreamPort, path: request.url, method: request.method,
      headers,
    }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    });
    upstream.on('error', () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('看板暂时不可用，请稍后重试。');
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  const page = certificatePage(settings, certificate);
  const bootstrap = httpServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    if (request.url === '/certificate.cer') {
      response.writeHead(200, { 'Content-Type': 'application/pkix-cert', 'Content-Disposition': 'attachment; filename="IBKR-Devbox-' + settings.hostname + '.cer"' }).end(certificate.raw);
    } else if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
    } else response.writeHead(404).end();
  });
  const servers: Server[] = [gateway, bootstrap];
  const close = async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    })));
  };
  try {
    await listen(gateway, settings.port, settings.hostname);
    await listen(bootstrap, settings.certificatePort, settings.hostname);
  } catch (error) { await close(); throw error; }
  return { close };
}

function certificatePage(settings: IntranetHttps, certificate: X509Certificate): string {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>连接持仓看板</title><style>body{max-width:680px;margin:64px auto;padding:0 24px;font:17px/1.8 system-ui;color:#162334}a{color:#1769aa}li{margin:16px 0}small{overflow-wrap:anywhere;color:#596777}</style>' +
    '<h1>连接持仓看板</h1><p>首次在这台 Mac 上安装服务证书。完成后，收藏看板链接即可直接登录。</p><ol>' +
    '<li><a href="/certificate.cer">下载服务证书</a>，双击文件，添加到“钥匙串访问”的“登录”钥匙串。</li>' +
    '<li>找到 <b>IBKR Devbox ' + settings.hostname + '</b>，双击并展开“信任”。把“安全套接字层（SSL）”设为“始终信任”，关闭窗口并按提示确认。</li>' +
    '<li><a href="' + settings.publicUrl + '/">打开持仓看板</a>，进入后点击“连接 IB”。</li></ol>' +
    '<p>后续只需打开 <a href="' + settings.publicUrl + '/">' + settings.publicUrl + '</a>，保持能访问 devbox 的内网连接。</p>' +
    '<small>服务证书有效期至 ' + new Date(certificate.validTo).toISOString().slice(0, 10) + '。SHA-256：' + certificate.fingerprint256 + '</small></html>';
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
}

export function intranetHttpsSettings(env: NodeJS.ProcessEnv, app: { accessMode: string; host: string; port: number; publicUrl: string; intranetGatewayToken?: string }): IntranetHttps | undefined {
  const certFile = env.INTRANET_HTTPS_CERT_FILE?.trim(), keyFile = env.INTRANET_HTTPS_KEY_FILE?.trim();
  if (!certFile && !keyFile && app.accessMode !== 'intranet') return undefined;
  if (!certFile || !keyFile) throw new Error('内网 HTTPS 需要同时配置证书和私钥');
  const url = new URL(app.publicUrl);
  if (!['password', 'intranet'].includes(app.accessMode) || app.host !== '127.0.0.1' || url.protocol !== 'https:' || !isPrivateIPv4(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('内网 HTTPS 需要本机后端和 HTTPS 私有 IPv4 地址');
  }
  if (app.accessMode === 'intranet' && !app.intranetGatewayToken) throw new Error('内网免密入口缺少内部请求校验');
  const port = Number(url.port || 443), certificatePort = Number(env.INTRANET_CERT_PORT || 8080);
  for (const value of [port, certificatePort]) if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('内网 HTTPS 端口必须为 1024–65535');
  if (new Set([port, certificatePort, app.port]).size !== 3) throw new Error('内网 HTTPS、证书下载和后端端口不能重复');
  return { hostname: url.hostname, port, certificatePort, publicUrl: url.origin, certFile, keyFile, upstreamHost: app.host, upstreamPort: app.port,
    gatewayToken: app.accessMode === 'intranet' ? app.intranetGatewayToken : undefined };
}
