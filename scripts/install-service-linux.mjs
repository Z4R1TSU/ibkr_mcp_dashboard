import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'linux') throw new Error('此脚本仅用于 Linux systemd');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更高版本');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (/[\r\n]/.test(root)) throw new Error('项目路径不能包含换行符');
process.chdir(root);
const { config } = await import('../dist/server/config.js');
const name = 'ibkr-mcp-dashboard';
const node = fs.realpathSync(process.execPath);
const unitDirectory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user');
// Escape systemd specifiers and ExecStart dollar expansion as well as quotes.
const quote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
const argument = value => quote(value).replaceAll('$', '$$');
const servicePath = [path.dirname(node), path.join(os.homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
const common = [
  'WorkingDirectory=' + root.replaceAll('%', '%%'),
  'Environment=' + quote('PATH=' + servicePath),
  'Environment=NODE_ENV=production', 'UMask=0077', 'NoNewPrivileges=true',
];
const units = new Map([
  [name + '.service', [
    '[Unit]', 'Description=IBKR read-only portfolio dashboard', 'StartLimitIntervalSec=0', '',
    '[Service]', 'Type=simple', ...common,
    'ExecStart=' + argument(node) + ' ' + argument(path.join(root, 'dist/server/index.js')),
    // Leave enough time for the five-minute rotating-token exchange to settle.
    'Restart=always', 'RestartSec=5s', 'TimeoutStopSec=360s', 'KillMode=control-group',
    'StandardOutput=journal', 'StandardError=journal', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n')],
  [name + '-health.service', [
    '[Unit]', 'Description=Check IBKR dashboard HTTP health', '',
    '[Service]', 'Type=oneshot', ...common,
    'ExecStart=' + argument(node) + ' ' + argument(path.join(root, 'scripts/check-service.mjs')),
    'TimeoutStartSec=420s', '',
  ].join('\n')],
  [name + '-health.timer', [
    '[Unit]', 'Description=Periodically check IBKR dashboard HTTP health', '',
    '[Timer]', 'OnBootSec=2min', 'OnUnitActiveSec=1min', 'AccuracySec=10s', '',
    '[Install]', 'WantedBy=timers.target', '',
  ].join('\n')],
]);
if (process.argv.includes('--dry-run')) {
  for (const [file, contents] of units) console.log('# ' + path.join(unitDirectory, file) + '\n' + contents);
  process.exit(0);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 390000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || command + ' failed');
  return result.stdout.trim();
}
const systemctl = (...args) => run('systemctl', ['--user', ...args]);
systemctl('show', '--property=Version');
const linger = run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value']);
if (linger !== 'yes') throw new Error('请先由管理员执行 loginctl enable-linger ' + os.userInfo().username + '，以便开机启动并在退出登录后继续运行');
const oldDirectory = systemctl('show', name + '.service', '--property=WorkingDirectory', '--value');
if (oldDirectory && path.resolve(oldDirectory) !== root) throw new Error('已有同名服务使用其他项目目录：' + oldDirectory);
const active = spawnSync('systemctl', ['--user', 'is-active', '--quiet', name + '.service']).status === 0;
if (!active) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(config.port, config.host, () => probe.close(resolve));
  });
}
fs.mkdirSync(unitDirectory, { recursive: true });
for (const [file, contents] of units) fs.writeFileSync(path.join(unitDirectory, file), contents, { mode: 0o600 });
run('systemd-analyze', ['--user', 'verify', ...[...units.keys()].map(file => path.join(unitDirectory, file))]);
systemctl('daemon-reload');
systemctl('enable', name + '.service', name + '-health.timer');
systemctl('restart', name + '.service', name + '-health.timer');
const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
const healthUrl = 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + config.port + '/api/health';
let ready = false;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    ready = response.ok && (await response.json()).ok === true;
  } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!ready) throw new Error('启动验证失败，请检查 journalctl --user -u ' + name + '.service');
console.log('已启用开机自启、退出登录后常驻、崩溃重启及每分钟 HTTP 健康检查。');
console.log('看板：' + config.publicUrl);
console.log('状态：systemctl --user status ' + name + '.service');
console.log('日志：journalctl --user -u ' + name + '.service -f');
