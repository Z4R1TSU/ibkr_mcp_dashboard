import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { root, directory, config } from './login-storage.mjs';

export async function startDisplay(authDirectory = directory) {
  const runtime = path.join(root, '.runtime/tos-xvfb/root');
  const auth = path.join(authDirectory, 'Xauthority');
  const field = value => {
    const data = Buffer.from(value), length = Buffer.alloc(2);
    length.writeUInt16BE(data.length);
    return Buffer.concat([length, data]);
  };
  let n = 92;
  while (fs.existsSync('/tmp/.X' + n + '-lock') && n < 120) n++;
  const record = Buffer.concat([Buffer.from([255, 255]), field(''), field(String(n)),
    field('MIT-MAGIC-COOKIE-1'), field(randomBytes(16))]);
  fs.writeFileSync(auth, record, { mode: 0o600 });
  const libs = [path.join(runtime, 'usr/lib/x86_64-linux-gnu'), path.join(root, '.runtime/tos-browser-libs')].join(':');
  const env = { ...process.env, LD_LIBRARY_PATH: libs, DISPLAY: ':' + n, XAUTHORITY: auth };
  const local = path.join(runtime, 'usr/bin/Xvfb');
  const executable = config.TOS_XVFB_BIN || (fs.existsSync(local) ? local : '/usr/bin/Xvfb');
  const child = spawn(executable,
    [':' + n, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-auth', auth],
    { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let failed = false;
  child.on('error', () => { failed = true; });
  child.stderr.resume();
  await new Promise(resolve => setTimeout(resolve, 1200));
  if (failed || child.exitCode !== null) throw new Error('display_start_failed');
  return { env, stop: () => child.kill('SIGTERM') };
}
