import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform === 'linux') {
  await import('./install-service-linux.mjs');
  process.exit(0);
}
if (process.platform !== 'darwin') throw new Error('服务安装支持 Linux systemd 和 macOS launchd');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const { config } = await import('../dist/server/config.js');
const label = 'local.ibkr-mcp-dashboard';
const target = 'gui/' + process.getuid() + '/' + label;
const agent = path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist');
const logs = path.join(os.homedir(), 'Library', 'Logs', 'IBKRDashboard');
const node = process.execPath;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const string = value => '<string>' + xml(value) + '</string>';
const loaded = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8' });
const listener = spawnSync('/usr/sbin/lsof', ['-nP', '-iTCP:' + config.port, '-sTCP:LISTEN'], { encoding: 'utf8' });
if (loaded.status !== 0 && listener.status === 0 && listener.stdout.trim()) throw new Error('看板端口已被占用，请先停止手动启动的服务');
fs.mkdirSync(path.dirname(agent), { recursive: true });
fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
const stdout = path.join(logs, 'stdout.log'), stderr = path.join(logs, 'stderr.log');
for (const file of [stdout, stderr]) { fs.closeSync(fs.openSync(file, 'a', 0o600)); fs.chmodSync(file, 0o600); }
const cli = spawnSync('/usr/bin/which', ['lark-cli'], { encoding: 'utf8' }).stdout.trim();
const servicePath = [path.dirname(node), ...(cli ? [path.dirname(cli)] : []), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const plist = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0"><dict>',
  '<key>Label</key>' + string(label),
  '<key>ProgramArguments</key><array>' + string(node) + string(path.join(root, 'dist/server/index.js')) + '</array>',
  '<key>WorkingDirectory</key>' + string(root),
  '<key>EnvironmentVariables</key><dict><key>PATH</key>' + string(servicePath) + '</dict>',
  '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>',
  '<key>ThrottleInterval</key><integer>15</integer><key>ProcessType</key><string>Background</string>',
  '<key>StandardOutPath</key>' + string(stdout), '<key>StandardErrorPath</key>' + string(stderr),
  '</dict></plist>',
].join('\n');
fs.writeFileSync(agent, plist, { mode: 0o600 });
if (loaded.status === 0) {
  const oldPid = Number(/\n\s*pid = (\d+)/.exec(loaded.stdout)?.[1]);
  spawnSync('/bin/launchctl', ['bootout', target], { stdio: 'ignore' });
  for (let i = 0; oldPid && i < 40; i++) {
    try { process.kill(oldPid, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
let result;
for (let attempt = 0; attempt < 5; attempt++) {
  result = spawnSync('/bin/launchctl', ['bootstrap', 'gui/' + process.getuid(), agent], { encoding: 'utf8' });
  if (result.status === 0 || !result.stderr.includes('Input/output error')) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (result.status !== 0) throw new Error(result.stderr || '登录服务安装失败');
let ready = false;
for (let attempt = 0; attempt < 15; attempt++) {
  try { ready = (await fetch(config.publicUrl + '/api/health', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!ready) {
  spawnSync('/bin/launchctl', ['bootout', target], { stdio: 'ignore' });
  fs.renameSync(agent, agent + '.disabled');
  throw new Error('启动验证失败，启动项已停用。检查日志目录：' + logs);
}
console.log('登录自启服务已运行：' + label);
console.log('日志目录：' + logs);
