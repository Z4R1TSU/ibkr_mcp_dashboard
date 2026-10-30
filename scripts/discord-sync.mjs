import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { DiscordBridge, bounded } from '../dist/server/discord/bridge.js';
import { createPresenceConnection } from '../dist/server/discord/rpc.js';
import { RemoteActivity } from '../dist/server/discord/remote-activity.js';
import { openTunnel } from './discord-tunnel.mjs';
import { dashboardAddress, createDashboardRequest, connectionError } from './discord-http.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = parse(fs.readFileSync(process.env.IBKR_DISCORD_SYNC_CONFIG || path.join(root, '.env.discord-sync')));
let address = dashboardAddress(env.DASHBOARD_URL || 'http://127.0.0.1');
if (!/^[a-f0-9]{64}$/.test(env.DISCORD_SYNC_TOKEN || '')) throw new Error('Invalid DISCORD_SYNC_TOKEN');
if (env.DASHBOARD_ACCESS_MODE === 'intranet' && env.SSH_TARGET?.trim()) throw new Error('内网免密模式须使用 HTTPS 直连，请清空 SSH_TARGET');
const tunnel = await openTunnel(env);
if (tunnel) address = new URL(tunnel.url);
let current;
const activity = new RemoteActivity();
let stopping = false;
let timer;
let polling = false;
const controller = new AbortController();
const request = createDashboardRequest(address, env, root, controller.signal);
const bridge = new DiscordBridge(
  () => ({ enabled: Boolean(current?.settings.enabled), applicationId: current?.settings.applicationId || '', startDate: '' }),
  () => activity.get(),
);
if (tunnel) {
  const failed = () => {
    if (!stopping) { console.error('SSH 连接断开；请确认 Mac 可免密 SSH 登录配置的服务器。'); void stop(1); }
  };
  tunnel.child.on('error', failed);
  tunnel.child.on('exit', failed);
}
async function read() {
  const value = await request('/api/discord/remote');
  if (typeof value?.settings?.enabled !== 'boolean' || typeof value.settings.applicationId !== 'string'
    || !value.summary || value.summary.version !== 1
    || !(value.summary.activity === null || typeof value.summary.activity?.details === 'string' && typeof value.summary.activity?.state === 'string')) throw new Error('Invalid Discord summary');
  return value;
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.on('exit', () => tunnel?.child.kill('SIGTERM'));
if (process.argv.includes('--check') || process.argv.includes('--check-server')) {
  let value;
  let failure;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { value = await read(); break; } catch (error) {
      failure = error;
      if (!tunnel || /^Dashboard HTTP 4/.test(error.message)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!value) { console.error(connectionError(failure)); await stop(1); }
  let rpcConnected = false;
  if (process.argv.includes('--check')) {
    if (!/^[0-9]{17,20}$/.test(value.settings.applicationId)) {
      console.error('请先在看板的 Discord 设置中保存 Application ID');
      await stop(1);
    }
    const connection = createPresenceConnection(value.settings.applicationId);
    try {
      await bounded(connection.connect());
      rpcConnected = connection.connected;
      if (!rpcConnected) throw new Error('RPC not ready');
    } catch {
      console.error('看板连接正常，但无法连接 Discord。请打开并登录 Discord 桌面端，确认 Application ID 后重新安装。');
      await bounded(connection.close(), 2000).catch(() => {});
      await stop(1);
    }
    await bounded(connection.close(), 2000).catch(() => {});
  }
  console.log(JSON.stringify({ authenticated: true, rpcConnected, enabled: value.settings.enabled, snapshotTime: value.summary.accountAsOf, stale: value.summary.stale }));
  stopping = true;
  tunnel?.child.kill('SIGTERM');
  process.exit(0);
}
let lastStatus;
async function poll() {
  if (polling || stopping) return;
  polling = true;
  const started = Date.now();
  try {
    const value = await read();
    if (stopping) return;
    if (Date.now() - started >= 45000) throw new Error('Discarding response started before sleep');
    current = value;
    activity.accept(current.summary, current.settings.applicationId);
    await bridge.sync();
    const status = { connected: bridge.connected && Boolean(activity.get()) && Boolean(bridge.lastSentAt) && !bridge.error,
      lastSentAt: bridge.lastSentAt, error: bridge.error ?? activity.error };
    await request('/api/discord/remote/status', status);
    const message = status.error || (status.connected ? 'Discord 已连接并同步' : current.settings.enabled ? '等待可展示的活动数据' : 'Discord 同步未开启');
    if (message !== lastStatus) console.log(message);
    lastStatus = message;
  } catch (error) {
    activity.disconnect();
    await bridge.sync();
    if (!stopping && lastStatus !== 'offline') console.error(connectionError(error) + '；已清除活动，将自动重试。');
    lastStatus = 'offline';
  } finally {
    polling = false;
    if (!stopping) timer = setTimeout(poll, Date.now() - started >= 45000 ? 0 : 15000);
  }
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  controller.abort();
  tunnel?.child.kill('SIGTERM');
  await bridge.stop();
  process.exit(code);
}
bridge.start();
void poll();
