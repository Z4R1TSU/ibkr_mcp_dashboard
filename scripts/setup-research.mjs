import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [process.env.TRADINGAGENTS_SETUP_PYTHON, 'python3.13', 'python3.12', 'python3.11', 'python3', '/opt/homebrew/bin/python3.12'].filter(Boolean);
const python = candidates.find(candidate => spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'], { stdio: 'ignore' }).status === 0);
if (!python) throw new Error('需要 Python 3.11 或更高版本；可用 TRADINGAGENTS_SETUP_PYTHON 指定解释器。');
const environment = path.join(root, '.venv-tradingagents');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('TradingAgents 安装失败，请检查 Python 版本与网络。');
}
if (!fs.existsSync(environment)) run(python, ['-m', 'venv', environment]);
const executable = path.join(environment, 'bin/python');
run(executable, ['-m', 'pip', 'install', '--no-cache-dir', '-r', 'integrations/tradingagents/requirements.txt']);
run(executable, ['-m', 'pip', 'check']);
console.log('TradingAgents 已安装。飞书发送 /research AAPL 开始只读研究；未启动研究、未修改模型配置。');
