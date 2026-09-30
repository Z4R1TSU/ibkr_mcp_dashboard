import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelConfig } from '../bot/config.js';
import type { DashboardState } from '../../shared/types.js';
import { startModelBridge } from './bridge.js';

export interface ResearchInput { ticker: string; date: string; account: object | null; directory: string }
export interface ResearchResult { summary: string; report: string; rating: string; revision: string; model: string; analysts: string[] }
export interface ResearchRunner {
  readonly modelName: string;
  unavailable(): string | null;
  run(input: ResearchInput, signal: AbortSignal, progress: (stage: string, calls?: number) => void): Promise<ResearchResult>;
}
export interface ResearchConfig { enabled: boolean; python: string; worker: string; timeoutMs: number; maxCalls: number }

export function researchConfig(env: NodeJS.ProcessEnv, root = process.cwd()): ResearchConfig {
  if (env.TRADINGAGENTS_ENABLED && !['true', 'false'].includes(env.TRADINGAGENTS_ENABLED)) throw new Error('TRADINGAGENTS_ENABLED must be true or false');
  const timeout = Number(env.TRADINGAGENTS_TIMEOUT_SECONDS || 1800);
  const maxCalls = Number(env.TRADINGAGENTS_MAX_CALLS || 100);
  if (!Number.isSafeInteger(timeout) || timeout < 60 || timeout > 7200) throw new Error('TRADINGAGENTS_TIMEOUT_SECONDS must be 60–7200');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 300) throw new Error('TRADINGAGENTS_MAX_CALLS must be 1–300');
  return { enabled: env.TRADINGAGENTS_ENABLED !== 'false', python: path.resolve(env.TRADINGAGENTS_PYTHON || path.join(root, '.venv-tradingagents/bin/python')),
    worker: path.join(root, 'integrations/tradingagents/worker.py'), timeoutMs: timeout * 1000, maxCalls };
}

export function researchDate(now = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

export function researchAccount(state: DashboardState): object | null {
  if (!state.snapshot) return null;
  return {
    fetchedAt: state.snapshot.fetchedAt, stale: state.status.stale || !state.status.connected,
    account: { currency: state.snapshot.account.currency, nav: state.snapshot.account.nav, cash: state.snapshot.account.cash,
      availableFunds: state.snapshot.account.availableFunds, excessLiquidity: state.snapshot.account.excessLiquidity },
    positions: state.snapshot.positions.map(position => ({ symbol: position.symbol, kind: position.kind, currency: position.currency,
      quantity: position.quantity, averagePrice: position.averagePrice, value: position.value, navWeight: position.navWeight, option: position.option })),
    warnings: state.snapshot.analysis.warnings,
  };
}

export function workerEnvironment(directory: string, token: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: source.PATH || '/usr/bin:/bin', HOME: directory, TMPDIR: directory, PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1', PYTHON_DOTENV_DISABLED: '1', PYTHONUTF8: '1', LANG: 'en_US.UTF-8',
    OPENAI_COMPATIBLE_API_KEY: token, LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
  for (const name of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) if (source[name]) environment[name] = source[name];
  return environment;
}

export class PythonResearchRunner implements ResearchRunner {
  constructor(private readonly config: ResearchConfig, private readonly model: ModelConfig) {}
  get modelName(): string { return this.model.name; }
  unavailable(): string | null {
    if (!this.config.enabled) return 'TradingAgents 已在配置中关闭。';
    if (!this.model.apiKey || !this.model.baseUrl || !this.model.name) return '请先配置持仓助手的模型。';
    if (!fs.existsSync(this.config.python) || !fs.existsSync(this.config.worker)) return '研究运行环境未安装，请在服务电脑运行 npm run research:setup。';
    return null;
  }
  async run(input: ResearchInput, signal: AbortSignal, progress: (stage: string, calls?: number) => void): Promise<ResearchResult> {
    const reason = this.unavailable();
    if (reason) throw new Error(reason);
    const deadline = AbortSignal.timeout(this.config.timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    combined.throwIfAborted();
    fs.mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    for (const filename of ['.env', '.env.enterprise']) fs.writeFileSync(path.join(input.directory, filename), '', { mode: 0o600 });
    const bridge = await startModelBridge(this.model, { maxCalls: this.config.maxCalls, signal: combined, onCall: calls => progress('模型研究中', calls),
      onThrottle: seconds => progress('模型接口限流，等待 ' + seconds + ' 秒后重试') });
    try {
      return await new Promise<ResearchResult>((resolve, reject) => {
        const child = spawn(this.config.python, ['-I', this.config.worker], { cwd: input.directory, env: workerEnvironment(input.directory, bridge.token), stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        let bytes = 0;
        let result: ResearchResult | undefined;
        let failure = '';
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const terminate = () => { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 3000); };
        combined.addEventListener('abort', terminate, { once: true });
        if (combined.aborted) terminate();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 4 * 1024 * 1024) { failure = '研究输出超过安全限制。'; terminate(); return; }
          output += chunk;
          for (;;) {
            const newline = output.indexOf('\n');
            if (newline < 0) break;
            const line = output.slice(0, newline); output = output.slice(newline + 1);
            try {
              const event = JSON.parse(line);
              if (event.event === 'progress' && typeof event.stage === 'string') progress(event.stage);
              if (event.event === 'error') failure = 'TradingAgents 研究失败（' + String(event.errorType).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 60) + '），未生成完整报告。'
                + (typeof event.detail === 'string' ? '\n' + event.detail.replaceAll(bridge.token, '[redacted]').slice(0, 500) : '');
              if (event.event === 'result' && typeof event.summary === 'string' && typeof event.report === 'string'
                && event.model === this.model.name && event.revision === '8b22d43d01d9ddda5d686d093d5385884622f3de'
                && Array.isArray(event.analysts) && event.analysts.length === 4) result = event;
            } catch { failure = '研究进程输出格式无效。'; terminate(); }
          }
        });
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.on('error', () => { failure = '无法启动研究运行环境，请运行 npm run research:setup。'; });
        child.on('close', code => {
          clearTimeout(killTimer);
          combined.removeEventListener('abort', terminate);
          if (signal.aborted) reject(new Error('研究已取消。'));
          else if (deadline.aborted) reject(new Error('研究超过运行时限，已停止；没有下单。'));
          else if (failure || code !== 0 || !result) reject(new Error(failure || '研究进程未正常完成，未生成完整报告。'));
          else resolve(result);
        });
        child.stdin.end(JSON.stringify({ ticker: input.ticker, date: input.date, account: input.account,
          bridgeUrl: bridge.url, model: this.model.name, maxTokens: this.model.maxTokens, timeoutSeconds: this.config.timeoutMs / 1000 + 5 }));
      });
    } finally { await bridge.close(); }
  }
}
