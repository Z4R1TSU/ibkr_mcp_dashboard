export interface AccessSettings {
  accessMode: 'local' | 'password';
  host: string;
  port: number;
  publicUrl: string;
}

export function createAccessPolicy(settings: AccessSettings) {
  const address = new URL(settings.publicUrl);
  const localAccess = settings.accessMode === 'local';
  const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
  if (localAccess && (!['127.0.0.1', 'localhost', '::1'].includes(settings.host) || !loopbackHosts.includes(address.hostname) || address.protocol !== 'http:' || Number(address.port || 80) !== settings.port)) {
    throw new Error('Local password-free access requires a loopback HTTP address matching the listening port');
  }
  const origins = new Set(localAccess ? loopbackHosts.map(hostname => new URL(`http://${hostname}:${settings.port}`).origin) : [address.origin]);
  return { localAccess, origin: address.origin, secure: address.protocol === 'https:', origins, hosts: new Set([...origins].map(origin => new URL(origin).host)) };
}

export function isDirectLocalRequest(policy: ReturnType<typeof createAccessPolicy>, request: {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  fetchSite?: string;
  apiRequest: boolean;
  forwarded: boolean;
}): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.remoteAddress ?? '')) return false;
  if (!request.host || !policy.hosts.has(request.host.toLowerCase()) || request.forwarded) return false;
  if (request.origin !== undefined && !policy.origins.has(request.origin)) return false;
  if (request.apiRequest && request.fetchSite !== undefined && !['same-origin', 'none'].includes(request.fetchSite)) return false;
  return true;
}
