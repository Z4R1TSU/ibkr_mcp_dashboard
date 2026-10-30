import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { researchConfig, workerEnvironment } from '../server/research/runner.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-doctor-'));
try {
  const config = researchConfig(process.env);
  const result = spawnSync(config.python, ['-I', path.resolve('integrations/tradingagents/doctor.py')], {
    env: workerEnvironment(directory, 'unused-diagnostic-token'), cwd: directory,
    encoding: 'utf8', timeout: 45000, maxBuffer: 128 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error) console.error('研究数据诊断未完成：' + (result.error as NodeJS.ErrnoException).code);
  else if (result.stderr) console.error('研究数据诊断失败，请检查 Python 研究环境。');
  process.exitCode = result.status === 0 ? 0 : 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
