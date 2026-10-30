import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config, intranetHttps } from '../dist/server/config.js';
import { X509Certificate } from 'node:crypto';
import { RemoteDiscord } from '../dist/server/discord/remote.js';

process.umask(0o077);
const target = process.argv[2] || '';
if (target && !/^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]*$/.test(target)) throw new Error('Provide one SSH hostname or alias');
if (config.discordTransport !== 'remote') throw new Error('Set DISCORD_TRANSPORT=remote before packaging');
if (target && config.accessMode === 'intranet') throw new Error('Intranet mode requires direct HTTPS; omit the SSH target');
new RemoteDiscord(config.dataDir);
const token = fs.readFileSync(path.join(config.dataDir, 'discord-sync-token'), 'utf8').trim();
const staging = fs.mkdtempSync(path.join(config.dataDir, '.discord-package-'));
const output = path.join(staging, 'discord-mac');
try {
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
for (const file of ['scripts/discord-sync.mjs', 'scripts/discord-http.mjs', 'scripts/discord-tunnel.mjs', 'scripts/install-discord-mac.mjs', 'dist/server/discord/bridge.js', 'dist/server/discord/rpc.js', 'dist/server/discord/remote-activity.js']) {
  fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
  fs.copyFileSync(file, path.join(output, file));
}
fs.copyFileSync('scripts/discord-launch-agent.mjs', path.join(output, 'scripts/discord-launch-agent.mjs'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const dependencies = { '@xhayper/discord-rpc': '1.5.1', dotenv: '17.2.3' };
const selected = new Map();
function resolve(parent, name) {
  let prefix = parent;
  for (;;) {
    const key = (prefix ? prefix + '/' : '') + 'node_modules/' + name;
    if (lock.packages[key]) return key;
    if (!prefix) throw new Error('Missing dependency: ' + name);
    const at = prefix.lastIndexOf('/node_modules/');
    prefix = at < 0 ? '' : prefix.slice(0, at);
  }
}
function include(key) {
  if (key === undefined || selected.has(key)) return;
  const entry = lock.packages[key];
  if (entry.os || entry.cpu) throw new Error('Platform-specific dependency cannot be bundled: ' + key);
  selected.set(key, entry);
  for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) include(resolve(key, name));
}
for (const name of Object.keys(dependencies)) include(resolve('', name));
for (const [key] of selected) {
  fs.mkdirSync(path.dirname(path.join(output, key)), { recursive: true });
  fs.cpSync(key, path.join(output, key), { recursive: true });
}
const manifest = { name: 'ibkr-discord-sync', version: '0.1.2', private: true, type: 'module', engines: { node: '>=24' }, dependencies };
let certificateFile = '';
if (!target && intranetHttps) {
  const certificate = new X509Certificate(fs.readFileSync(intranetHttps.certFile));
  if (!certificate.checkIP(new URL(config.publicUrl).hostname) || Date.parse(certificate.validTo) <= Date.now()) throw new Error('Dashboard certificate is expired or does not match PUBLIC_URL');
  certificateFile = 'certs/dashboard.crt';
  fs.mkdirSync(path.join(output, 'certs'), { mode: 0o700 });
  fs.writeFileSync(path.join(output, certificateFile), certificate.toString(), { mode: 0o600 });
}
fs.copyFileSync('scripts/discord-mac-install.command', path.join(output, 'Install.command'));
fs.chmodSync(path.join(output, 'Install.command'), 0o700);
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(output, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: { '': manifest, ...Object.fromEntries(selected) } }, null, 2));
fs.writeFileSync(path.join(output, '.env.discord-sync'), [
  'DASHBOARD_URL=' + config.publicUrl,
  'DASHBOARD_ACCESS_MODE=' + config.accessMode,
  'DASHBOARD_CA_FILE=' + certificateFile,
  'SSH_TARGET=' + target,
  'DASHBOARD_REMOTE_PORT=' + config.port,
  'DISCORD_SYNC_TOKEN=' + token, '',
].join('\n'), { mode: 0o600 });
fs.writeFileSync(path.join(output, 'README.txt'), [
  '需要 Node.js 24+（https://nodejs.org/）和已登录的 Discord 桌面端。',
  '1. Mac 须能访问看板地址：' + config.publicUrl,
  target ? '本包使用 SSH；先确认 Mac 可免密 SSH 登录 ' + target : '本包通过 HTTPS 直连；所需公开服务证书已随包携带。',
  '2. 解压后双击 Install.command。若系统阻止，按 macOS 提示在“隐私与安全性”中允许该文件。',
  '   也可在解压目录运行：node scripts/install-discord-mac.mjs',
  '3. 安装检查会验证服务器和 Discord 本机连接；成功后设为登录自启。',
  '   重装会等待旧服务退出并自动重试；确认新进程持续运行后才报告安装成功，无需 sudo。',
  '   服务器连接验证成功后会停用旧 local.ibkr-mcp-dashboard 启动项，防止两套程序重复发布；旧数据保留。',
  '4. 在看板的 Discord 设置中开启同步，检查“最近成功同步”和个人活动卡片。',
  '安装位置：~/Library/Application Support/IBKRDiscord',
  '日志：~/Library/Logs/IBKRDiscord',
  '关闭：launchctl bootout gui/$(id -u)/local.ibkr-discord-sync',
  '仅息屏或锁屏时继续同步；日期回退的摘要不会覆盖较新的数据，每分钟重新推送当前卡片。',
  '完全休眠时本机程序无法更新，恢复后重新读取摘要；手机端显示可能有刷新延迟。',
  '本包包含专用摘要令牌，请私下保管；不含 IB 令牌、模型密钥或服务证书私钥。',
  '',
].join('\n'));
const archive = path.join(config.dataDir, 'discord-mac.tar.gz');
const temporary = path.join(staging, 'discord-mac.tar.gz');
const result = spawnSync('tar', ['-czf', temporary, '-C', staging, 'discord-mac'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || 'Unable to package Mac sync');
fs.chmodSync(temporary, 0o600);
fs.renameSync(temporary, archive);
console.log(JSON.stringify({ archive, dependencies: selected.size, includesIbTokens: false, includesModelKey: false }));
} finally { fs.rmSync(staging, { recursive: true, force: true }); }
