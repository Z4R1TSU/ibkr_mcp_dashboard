import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const { config } = await import('../dist/server/config.js');
const service = 'ibkr-mcp-dashboard.service';
function state() {
  const result = spawnSync('systemctl', ['--user', 'show', service, '--property=ActiveState', '--value'], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) throw new Error('无法读取看板服务状态');
  return result.stdout.trim();
}
// Respect an explicit stop; Restart=always handles a crashed process.
if (!['active', 'failed'].includes(state())) process.exit(0);
const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
const url = 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + config.port + '/api/health';
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (response.ok && (await response.json()).ok === true) process.exit(0);
  } catch {}
  if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!['active', 'failed'].includes(state())) process.exit(0);
console.error('Dashboard HTTP health check failed three times; restarting service.');
const restart = spawnSync('systemctl', ['--user', 'restart', service], { encoding: 'utf8', timeout: 390000 });
if (restart.error || restart.status !== 0) throw new Error('看板自动重启失败：' + (restart.error?.message || restart.stderr));
