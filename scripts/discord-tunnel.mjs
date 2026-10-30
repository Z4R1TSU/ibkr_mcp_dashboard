import net from 'node:net';
import { spawn } from 'node:child_process';

export async function openTunnel(env) {
  const target = env.SSH_TARGET?.trim();
  if (!target) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]*$/.test(target)) throw new Error('Invalid SSH_TARGET; use a hostname or SSH config alias');
  const sshPort = Number(env.SSH_PORT || 22);
  const remotePort = Number(env.DASHBOARD_REMOTE_PORT || 8048);
  for (const port of [sshPort, remotePort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const args = ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10'];
  if (env.SSH_PORT) args.push('-p', String(sshPort));
  if (env.SSH_IDENTITY_FILE) args.push('-i', env.SSH_IDENTITY_FILE);
  args.push('-L', `127.0.0.1:${port}:127.0.0.1:${remotePort}`, target);
  const child = spawn('/usr/bin/ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.resume();
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return { child, url: `http://127.0.0.1:${port}` };
}
