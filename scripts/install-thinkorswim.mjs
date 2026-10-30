import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Requires Linux and Node 24');
const unitDir = path.join(os.homedir(), '.config/systemd/user');
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
const units = [
  ['thinkorswim-market', [path.join(root, '.venv-tradingagents/bin/python'), '-I', path.join(root, 'integrations/thinkorswim/run.py')]],
  ['thinkorswim-login', [process.execPath, path.join(root, 'integrations/thinkorswim/login-server.mjs')]],
];
const contents = units.map(([name, args]) => [name, [
  '[Unit]', 'Description=Thinkorswim read-only ' + name, 'StartLimitIntervalSec=0', '',
  '[Service]', 'Type=simple', 'WorkingDirectory=' + root,
  'ExecStart=' + args.map(quote).join(' '), 'UMask=0077', 'NoNewPrivileges=true',
  'Restart=always', 'RestartSec=5', 'TimeoutStopSec=30', 'KillMode=control-group',
  'Environment=PYTHONUNBUFFERED=1', 'StandardOutput=journal', 'StandardError=journal',
  '', '[Install]', 'WantedBy=default.target', '',
].join('\n')]);
if (process.argv.includes('--dry-run')) {
  for (const [name, text] of contents) console.log(name + '.service\n' + text);
  process.exit(0);
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw new Error(command + ' failed; inspect service status locally');
}
run('systemctl', ['--user', 'show', '--property=Version']);
for (const file of ['.venv-tradingagents/bin/python', 'integrations/thinkorswim/node_modules/playwright-core/package.json']) {
  if (!fs.existsSync(path.join(root, file))) throw new Error('Missing runtime: ' + file);
}
fs.mkdirSync(unitDir, { recursive: true });
for (const [name, text] of contents) fs.writeFileSync(path.join(unitDir, name + '.service'), text, { mode: 0o600 });
run('systemd-analyze', ['--user', 'verify', ...contents.map(([name]) => path.join(unitDir, name + '.service'))]);
run('systemctl', ['--user', 'daemon-reload']);
run('systemctl', ['--user', 'enable', '--now', ...contents.map(([name]) => name + '.service')]);
console.log('Thinkorswim collector and login bridge enabled; both HTTP listeners use loopback.');
