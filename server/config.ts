import 'dotenv/config';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAccessPolicy } from './access.js';
import { intranetHttpsSettings } from './intranet-https.js';

const accessMode = process.env.ACCESS_MODE ?? 'password';
const discordTransport = process.env.DISCORD_TRANSPORT ?? 'local';
if (!['local', 'remote'].includes(discordTransport)) throw new Error('DISCORD_TRANSPORT must be local or remote');
if (discordTransport === 'remote' && !['password', 'intranet'].includes(accessMode)) throw new Error('Remote Discord sync requires ACCESS_MODE=password or intranet');
if (!['local', 'password', 'intranet'].includes(accessMode)) throw new Error('ACCESS_MODE must be local, intranet or password');

function bounded(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error('Invalid numeric configuration');
  return parsed;
}

export const config = {
  accessMode: accessMode as 'local' | 'password' | 'intranet',
  intranetGatewayToken: accessMode === 'intranet' ? randomBytes(32).toString('hex') : undefined,
  discordTransport: discordTransport as 'local' | 'remote',
  host: process.env.HOST ?? '127.0.0.1',
  port: bounded(process.env.PORT, 8048, 1024, 65535),
  publicUrl: process.env.PUBLIC_URL ?? 'http://127.0.0.1:8048',
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  pollSeconds: bounded(process.env.POLL_SECONDS, 60, 60, 3600),
  closedPollSeconds: bounded(process.env.CLOSED_POLL_SECONDS, 21600, 600, 86400),
  quoteBatchSize: bounded(process.env.QUOTE_BATCH_SIZE, 4, 0, 20),
  staleSeconds: bounded(process.env.STALE_SECONDS, 180, 60, 86400),
  sessionHours: bounded(process.env.SESSION_HOURS, 8, 1, 48),
  serverUrl: 'https://api.ibkr.com/v1/api/mcp-public',
};

const publicAddress = new URL(config.publicUrl);
if (!['https:', 'http:'].includes(publicAddress.protocol)) throw new Error('PUBLIC_URL must be HTTP(S)');
if (publicAddress.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(publicAddress.hostname)) {
  throw new Error('Public deployment requires an HTTPS PUBLIC_URL');
}
if (publicAddress.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(config.host)) {
  throw new Error('Plain HTTP must bind to loopback only');
}
createAccessPolicy(config);
export const intranetHttps = intranetHttpsSettings(process.env, config);
