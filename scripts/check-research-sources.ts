import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { researchConfig, workerEnvironment } from '../server/research/runner.js';

const ticker = (process.argv[2] || 'GOOG').toUpperCase();
if (!/^[A-Z][A-Z0-9.-]{0,19}$/.test(ticker) || ticker.includes('..')) throw new Error('Provide one valid ticker');
const config = researchConfig(process.env);
const root = path.resolve(process.env.DATA_DIR || 'data', 'research-source-verification');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const directory = fs.mkdtempSync(path.join(root, ticker + '-'));
console.log(JSON.stringify({ directory, modelCalls: 0, accountReads: 0, feishuMessages: 0 }));
const result = spawnSync(config.python, ['-I', path.resolve('integrations/tradingagents/source_doctor.py'), ticker], {
  cwd: directory, stdio: 'inherit', timeout: 180000,
  env: workerEnvironment(directory, 'unused-source-probe', { ...process.env,
    TRADINGAGENTS_PUBLIC_CACHE_DIR: config.publicCacheDir }),
});
if (result.error) console.error('数据源验证超时或未能启动；已取得的资料保留在上述目录。');
process.exitCode = result.status === 0 ? 0 : 1;
