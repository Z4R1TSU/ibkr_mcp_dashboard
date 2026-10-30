import { spawnSync } from 'node:child_process';

const execute = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pidOf = result => Number(/^\s*pid = (\d+)\s*$/m.exec(result.stdout || '')?.[1]) || 0;
const description = result => (result.error?.message || result.stderr || result.stdout || 'exit ' + result.status)
  .replace(/^Try re-running the command as root.*$/m, '').trim().slice(0, 2000);

async function unload(target, old, launchctl, isAlive, wait) {
  if (old.status !== 0) return;
  const oldPid = pidOf(old);
  const removed = launchctl('bootout', target);
  for (let attempt = 0; attempt < 80; attempt++) {
    const registered = launchctl('print', target).status === 0;
    if (!registered && (!oldPid || !isAlive(oldPid))) return;
    await wait(250);
  }
  throw new Error('旧同步服务尚未退出，未启动第二个实例。请稍后重新安装。'
    + (removed.status !== 0 ? '\n' + description(removed) : ''));
}

export async function retireLegacyDashboard(uid, { run = execute, isAlive = alive, wait = pause } = {}) {
  const target = 'gui/' + uid + '/local.ibkr-mcp-dashboard';
  const launchctl = (...args) => run('/bin/launchctl', args);
  const disabled = launchctl('disable', target);
  if (disabled.status !== 0) throw new Error('无法停用旧本地看板：' + description(disabled));
  await unload(target, launchctl('print', target), launchctl, isAlive, wait);
}

export async function installLaunchAgent({ uid, label, file, logs }, { run = execute, isAlive = alive, wait = pause } = {}) {
  const domain = 'gui/' + uid, target = domain + '/' + label;
  const launchctl = (...args) => run('/bin/launchctl', args);
  const lint = run('/usr/bin/plutil', ['-lint', file]);
  if (lint.status !== 0) throw new Error('启动项格式校验失败：' + description(lint));
  const enabled = launchctl('enable', target);
  if (enabled.status !== 0) throw new Error('无法启用当前用户的同步服务：' + description(enabled));
  const old = launchctl('print', target);
  // bootout can return before launchd removes the registration or the process exits.
  await unload(target, old, launchctl, isAlive, wait);
  let result;
  for (let attempt = 0; attempt < 6; attempt++) {
    result = launchctl('bootstrap', domain, file);
    if (result.status === 0) break;
    if (result.status !== 5 && !/Input\/output error/i.test(result.stderr || '')) break;
    if (attempt < 5) await wait(1000);
  }
  if (result.status !== 0) throw new Error('同步服务注册失败，已等待旧服务退出并重试。\n'
    + description(result) + '\n日志目录：' + logs);
  let last, pid = 0, consecutive = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    last = launchctl('print', target);
    const currentPid = last.status === 0 ? pidOf(last) : 0;
    if (currentPid && isAlive(currentPid)) {
      consecutive = currentPid === pid ? consecutive + 1 : 1;
      pid = currentPid;
      if (consecutive >= 3) return { pid };
    } else { consecutive = 0; pid = 0; }
    await wait(500);
  }
  const exitCode = /^\s*last exit code = (.+)$/m.exec(last?.stdout || '')?.[1];
  throw new Error('启动项已注册，但同步程序未能持续运行。'
    + (exitCode ? '退出码：' + exitCode + '。' : '') + '\n请查看日志目录：' + logs);
}
