import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installLaunchAgent, retireLegacyDashboard } from './discord-launch-agent.mjs';

if (process.platform !== 'darwin') throw new Error('This installer is for the Mac running Discord');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node.js 24 or later first');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(os.homedir(), 'Library/Application Support/IBKRDiscord');
if (source !== root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const file of ['scripts', 'dist', 'node_modules', 'package.json', 'package-lock.json', '.env.discord-sync']) {
    fs.cpSync(path.join(source, file), path.join(root, file), { recursive: true });
  }
  if (fs.existsSync(path.join(source, 'certs'))) fs.cpSync(path.join(source, 'certs'), path.join(root, 'certs'), { recursive: true });
}
const check = spawnSync(process.execPath, [path.join(root, 'scripts/discord-sync.mjs'), '--check'], { encoding: 'utf8', timeout: 120000 });
if (check.status !== 0) throw new Error('安装检查未通过：\n' + (check.stderr || check.stdout || check.error?.message || '连接检查超时'));
console.log(check.stdout.trim());
const legacy = path.join(os.homedir(), 'Library/LaunchAgents/local.ibkr-mcp-dashboard.plist');
if (fs.existsSync(legacy)) {
  console.log('检测到旧本地看板启动项，正在停用，避免与服务器同步程序重复发布活动…');
  await retireLegacyDashboard(process.getuid());
}
const label = 'local.ibkr-discord-sync';
const agent = path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist');
const logs = path.join(os.homedir(), 'Library/Logs/IBKRDiscord');
fs.accessSync(path.join(root, '.env.discord-sync'));
fs.chmodSync(path.join(root, '.env.discord-sync'), 0o600);
fs.mkdirSync(path.dirname(agent), { recursive: true });
fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
for (const name of ['stdout.log', 'stderr.log']) { const file = path.join(logs, name); fs.closeSync(fs.openSync(file, 'a', 0o600)); fs.chmodSync(file, 0o600); }
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const string = value => '<string>' + xml(value) + '</string>';
const plist = ['<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0"><dict>',
  '<key>Label</key>' + string(label),
  '<key>ProgramArguments</key><array>' + string(process.execPath) + string(path.join(root, 'scripts/discord-sync.mjs')) + '</array>',
  '<key>WorkingDirectory</key>' + string(root),
  '<key>EnvironmentVariables</key><dict><key>PATH</key>' + string([path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':')) + '<key>TMPDIR</key>' + string(os.tmpdir()) + '</dict>',
  '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>',
  '<key>StandardOutPath</key>' + string(path.join(logs, 'stdout.log')),
  '<key>StandardErrorPath</key>' + string(path.join(logs, 'stderr.log')),
  '</dict></plist>',
].join('\n');
fs.writeFileSync(agent, plist, { mode: 0o600 });
fs.chmodSync(agent, 0o600);
console.log('正在更新登录启动项，等待旧同步程序退出…');
await installLaunchAgent({ uid: process.getuid(), label, file: agent, logs });
console.log('Mac 同步服务已启动，并设为登录自启：' + label);
console.log('保持 Discord 桌面端登录；配置了 SSH_TARGET 时会自动建立隧道。日志：' + logs);
console.log('回到看板的 Discord 设置查看“最近成功同步”；若同步未开启，请勾选后保存。其他人是否可见仍取决于 Discord 活动分享设置。');
