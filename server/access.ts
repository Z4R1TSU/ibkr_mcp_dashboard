import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

export interface AccessSettings {
  accessMode: 'local' | 'password' | 'intranet';
  intranetGatewayToken?: string;
  host: string;
  port: number;
  publicUrl: string;
}

export function createAccessPolicy(settings: AccessSettings) {
  const address = new URL(settings.publicUrl);
  const localAccess = settings.accessMode === 'local';
  const intranetAccess = settings.accessMode === 'intranet';
  const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
  if (localAccess && (!['127.0.0.1', 'localhost', '::1'].includes(settings.host) || !loopbackHosts.includes(address.hostname) || address.protocol !== 'http:' || Number(address.port || 80) !== settings.port)) {
    throw new Error('Local password-free access requires a loopback HTTP address matching the listening port');
  }
  if (intranetAccess && (settings.host !== '127.0.0.1' || address.protocol !== 'https:' || !isPrivateIPv4(address.hostname) || !settings.intranetGatewayToken)) {
    throw new Error('Intranet password-free access requires the private HTTPS gateway and a loopback backend');
  }
  const origins = new Set(localAccess ? loopbackHosts.map(hostname => new URL(`http://${hostname}:${settings.port}`).origin) : [address.origin]);
  return { localAccess, intranetAccess, passwordless: localAccess || intranetAccess, gatewayToken: settings.intranetGatewayToken,
    origin: address.origin, secure: address.protocol === 'https:', origins, hosts: new Set([...origins].map(origin => new URL(origin).host)) };
}

export function isPrivateIPv4(value: string): boolean {
  const ip = value.replace(/^::ffff:/, ''), octets = ip.split('.').map(Number);
  return isIP(ip) === 4 && (octets[0] === 10 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168);
}

export function isIntranetPeer(value = ''): boolean {
  return isPrivateIPv4(value) || ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
}

interface AccessRequest {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  fetchSite?: string;
  apiRequest: boolean;
  forwarded: boolean;
  gatewayToken?: string;
}

export function isTrustedIntranetRequest(policy: ReturnType<typeof createAccessPolicy>, request: AccessRequest): boolean {
  const expected = policy.gatewayToken ?? '', actual = request.gatewayToken ?? '';
  if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) return false;
  return isDirectLocalRequest(policy, request);
}

export function isDirectLocalRequest(policy: ReturnType<typeof createAccessPolicy>, request: AccessRequest): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.remoteAddress ?? '')) return false;
  if (!request.host || !policy.hosts.has(request.host.toLowerCase()) || request.forwarded) return false;
  if (request.origin !== undefined && !policy.origins.has(request.origin)) return false;
  if (request.apiRequest && request.fetchSite !== undefined && !['same-origin', 'none'].includes(request.fetchSite)) return false;
  return true;
}
