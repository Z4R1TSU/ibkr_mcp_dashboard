import test from 'node:test';
import assert from 'node:assert/strict';
import { installLaunchAgent, retireLegacyDashboard } from '../scripts/discord-launch-agent.mjs';

const job = { uid: 501, label: 'local.ibkr-discord-sync',
  file: '/Users/Test User/Library/LaunchAgents/local.ibkr-discord-sync.plist',
  logs: '/Users/Test User/Library/Logs/IBKRDiscord' };
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const missing = () => ({ status: 3, stdout: '', stderr: 'Could not find service' });

function simulate(options: { old?: boolean; invalidPlist?: boolean; oldStuck?: boolean; failBootstrap?: number; crash?: boolean } = {}) {
  const calls: string[][] = [];
  let phase = options.old ? 'old' : 'absent', time = 0, boots = 0, enabled = false;
  const isAlive = (pid: number) => pid === 101 ? Boolean(options.oldStuck || time < 1000) : !options.crash;
  const wait = async (ms: number) => { time += ms; };
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === '/usr/bin/plutil') return options.invalidPlist ? { status: 1, stdout: '', stderr: 'invalid plist' } : ok();
    assert.equal(command, '/bin/launchctl');
    if (args[0] === 'enable') { enabled = true; return ok(); }
    if (args[0] === 'disable') return ok();
    if (args[0] === 'bootout') { phase = 'unloading'; return ok(); }
    if (args[0] === 'print') {
      if (phase === 'old' || phase === 'unloading' && (options.oldStuck || time < 500)) return ok('state = running\npid = 101\n');
      if (phase === 'new') return ok(options.crash ? 'state = waiting\nlast exit code = 1\n' : 'state = running\npid = 202\n');
      return missing();
    }
    assert.equal(args[0], 'bootstrap');
    assert.equal(enabled, true);
    assert.equal(args[1], 'gui/501');
    assert.equal(args[2], job.file);
    if (options.old) assert.ok(!isAlive(101), 'must await the old process before bootstrap');
    boots++;
    if (boots <= (options.failBootstrap ?? 0)) return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.' };
    phase = 'new';
    return ok();
  };
  return { calls, run, isAlive, wait, get boots() { return boots; } };
}

test('reinstall waits for launchd and the old PID, enables the service and retries transient bootstrap errors', async () => {
  const sim = simulate({ old: true, failBootstrap: 2 });
  assert.deepEqual(await installLaunchAgent(job, sim), { pid: 202 });
  assert.equal(sim.boots, 3);
  assert.equal(sim.calls.filter(call => call[1] === 'bootout').length, 1);
  assert.ok(sim.calls.every(call => call[0] !== 'sudo'));
});

test('first install accepts paths containing spaces and verifies a running process', async () => {
  const sim = simulate();
  assert.deepEqual(await installLaunchAgent(job, sim), { pid: 202 });
  assert.equal(sim.boots, 1);
  assert.ok(!sim.calls.some(call => call[1] === 'bootout'));
});

test('migration retires only the old dashboard and waits for its process to exit', async () => {
  const sim = simulate({ old: true });
  await retireLegacyDashboard(501, sim);
  assert.ok(sim.calls.some(call => call[1] === 'disable'));
  assert.ok(sim.calls.some(call => call[1] === 'bootout'));
  assert.ok(sim.calls.every(call => call[2] === 'gui/501/local.ibkr-mcp-dashboard'));
  assert.equal(sim.boots, 0);
});

test('an already stopped legacy dashboard is disabled without booting it back up', async () => {
  const sim = simulate();
  await retireLegacyDashboard(501, sim);
  assert.ok(!sim.calls.some(call => call[1] === 'bootout' || call[1] === 'bootstrap'));
});

test('an invalid plist is rejected before stopping or enabling a service', async () => {
  const sim = simulate({ old: true, invalidPlist: true });
  await assert.rejects(installLaunchAgent(job, sim), /格式校验失败/);
  assert.equal(sim.calls.length, 1);
});

test('an old process that will not exit cannot be replaced by a second instance', async () => {
  const sim = simulate({ old: true, oldStuck: true });
  await assert.rejects(installLaunchAgent(job, sim), /旧同步服务尚未退出/);
  assert.equal(sim.boots, 0);
});

test('permanent bootstrap errors are bounded and do not instruct a root installation', async () => {
  const sim = simulate({ failBootstrap: 99 });
  await assert.rejects(installLaunchAgent(job, sim), (error: Error) => {
    assert.match(error.message, /注册失败.*\nBootstrap failed: 5/);
    assert.ok(!error.message.includes('re-running the command as root'));
    return true;
  });
  assert.equal(sim.boots, 6);
});

test('a successful bootstrap followed by a crash is not reported as a successful installation', async () => {
  const sim = simulate({ crash: true });
  await assert.rejects(installLaunchAgent(job, sim), /未能持续运行.*退出码：1/);
});
