import fs from 'node:fs';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function dashboardAddress(value) {
  const address = new URL(value);
  if (address.username || address.password || address.search || address.hash || address.pathname !== '/'
    || !(address.protocol === 'https:' || address.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname))) {
    throw new Error('DASHBOARD_URL 必须是 HTTPS 地址或本机 SSH 转发地址');
  }
  return address;
}

export function createDashboardRequest(address, env, root, signal) {
  dashboardAddress(address.href);
  if (!/^[a-f0-9]{64}$/.test(env.DISCORD_SYNC_TOKEN || '')) throw new Error('DISCORD_SYNC_TOKEN 无效，请重新下载安装包');
  // Trust this connection's bundled public certificate without disabling TLS validation.
  const ca = env.DASHBOARD_CA_FILE ? fs.readFileSync(path.resolve(root, env.DASHBOARD_CA_FILE)) : undefined;
  const headers = { Authorization: 'Bearer ' + env.DISCORD_SYNC_TOKEN, Origin: address.origin, 'Content-Type': 'application/json' };
  return async (route, body) => {
    if (!['/api/discord/remote', '/api/discord/remote/status'].includes(route)) throw new Error('不支持的同步接口');
    const deadline = AbortSignal.timeout(8000);
    return new Promise((resolve, reject) => {
      const request = (address.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(route, address), {
        method: body === undefined ? 'GET' : 'POST', headers, ca,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      }, response => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('Dashboard HTTP ' + response.statusCode));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 65536) { response.destroy(new Error('服务器摘要超过大小限制')); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('服务器摘要不是有效 JSON')); }
        });
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
}

export function connectionError(error) {
  if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error?.code)) {
    return 'HTTPS 证书校验失败，请重新下载 Mac 安装包；服务证书须有效且匹配看板地址';
  }
  if (error?.message === 'Dashboard HTTP 401') return '同步令牌无效，请重新下载 Mac 安装包';
  if (error?.message === 'Dashboard HTTP 403') return '看板拒绝此访问来源；内网免密模式须使用原 HTTPS 地址直连';
  if (error?.message === 'Dashboard HTTP 404') return '服务器尚未开启远程 Discord 同步';
  return '无法连接看板，请检查 Mac 网络、看板地址和可选的 SSH 隧道';
}
