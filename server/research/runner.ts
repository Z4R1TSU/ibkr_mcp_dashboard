import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelConfig } from '../bot/config.js';
import type { DashboardState } from '../../shared/types.js';
import { startModelBridge } from './bridge.js';
import { transientCodes } from '../bot/request-errors.js';
import { ResearchQuotes, type ResearchMarketContext, type ResearchQuoteSource } from './quotes.js';

export interface ResearchInput { ticker: string; date: string; account: object | null | (() => Promise<object | null>); directory: string; marketContext?: ResearchMarketContext }
export interface ResearchResult {
  summary: string; report: string; messageReport?: string; rating: string; revision: string; model: string; analysts: string[];
  quality?: { status: 'complete' | 'partial'; missing: string[] };
  validation?: { status: 'passed' | 'corrected' | 'blocked'; correctedSections?: string[]; unverifiedStatements?: number };
}
export interface ResearchRunner {
  readonly modelName: string;
  unavailable(): string | null;
  run(input: ResearchInput, signal: AbortSignal, progress: (stage: string, calls?: number) => void): Promise<ResearchResult>;
}
export interface ResearchConfig { enabled: boolean; python: string; worker: string; timeoutMs: number; maxCalls: number; publicCacheDir?: string }

export function researchWorkerFailure(event: { errorType?: unknown; detail?: unknown; bridgeCode?: unknown }, ticker: string, token: string): string {
  if (typeof event.bridgeCode === 'string' && transientCodes.has(event.bridgeCode)) {
    const reason = event.bridgeCode === 'UND_ERR_CONNECT_TIMEOUT' ? '连接模型网关超时' : '模型网关连接失败';
    return reason + '（' + event.bridgeCode + '），本次研究已停止，未生成完整报告。请稍后重新发送 /research ' + ticker + '。';
  }
  if (event.bridgeCode === 'TimeoutError') return '模型请求超过时限，本次研究已停止，未生成完整报告。请稍后重新发送 /research ' + ticker + '。';
  // A known coverage limit, not a crash: show the worker's own explanation.
  if (event.errorType === 'UnsupportedIssuer' && typeof event.detail === 'string') return event.detail.slice(0, 500);
  return 'TradingAgents 研究失败（' + String(event.errorType).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 60) + '），未生成完整报告。'
    + (typeof event.detail === 'string' ? '\n' + event.detail.replaceAll(token, '[redacted]').slice(0, 500) : '');
}

export function researchConfig(env: NodeJS.ProcessEnv, root = process.cwd()): ResearchConfig {
  if (env.TRADINGAGENTS_ENABLED && !['true', 'false'].includes(env.TRADINGAGENTS_ENABLED)) throw new Error('TRADINGAGENTS_ENABLED must be true or false');
  const timeout = Number(env.TRADINGAGENTS_TIMEOUT_SECONDS || 1800);
  const maxCalls = Number(env.TRADINGAGENTS_MAX_CALLS || 100);
  if (!Number.isSafeInteger(timeout) || timeout < 60 || timeout > 7200) throw new Error('TRADINGAGENTS_TIMEOUT_SECONDS must be 60–7200');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 300) throw new Error('TRADINGAGENTS_MAX_CALLS must be 1–300');
  return { enabled: env.TRADINGAGENTS_ENABLED !== 'false', python: path.resolve(env.TRADINGAGENTS_PYTHON || path.join(root, '.venv-tradingagents/bin/python')),
    worker: path.join(root, 'integrations/tradingagents/worker.py'), timeoutMs: timeout * 1000, maxCalls,
    publicCacheDir: path.resolve(env.DATA_DIR || path.join(root, 'data'), 'research-source-cache') };
}

export function researchDate(now = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

export function researchAccount(state: DashboardState): object | null {
  if (!state.snapshot) return null;
  return {
    fetchedAt: state.snapshot.fetchedAt, sources: state.snapshot.sources, stale: state.status.stale || !state.status.connected,
    account: { ...state.snapshot.account },
    balances: state.snapshot.balances.map(balance => ({ ...balance })),
    positions: state.snapshot.positions.map(position => ({ symbol: position.symbol, kind: position.kind, currency: position.currency,
      quantity: position.quantity, price: position.price, averagePrice: position.averagePrice, value: position.value,
      unrealizedPnl: position.unrealizedPnl, navWeight: position.navWeight, option: position.option,
      quote: state.quotes?.[position.id] ? (({ id: _id, ...quote }) => quote)(state.quotes[position.id]) : null })),
    analysis: { ...state.snapshot.analysis, options: state.snapshot.analysis.options.map(({ id: _id, ...risk }) => risk) },
    units: { navWeight: 'fraction of NAV, not percent; null when currencies differ',
      marginBufferRatio: 'excessLiquidity / equityWithLoan, not NAV',
      optionNotional: 'contracts * multiplier * strike; not option market value or delta exposure',
      prices: 'broker values preserved; do not infer option cost/P&L units from averagePrice' },
    quoteError: state.status.quoteError ?? null,
    warnings: state.snapshot.analysis.warnings,
  };
}

export function workerEnvironment(directory: string, token: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: source.PATH || '/usr/bin:/bin', HOME: directory, TMPDIR: directory, PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1', PYTHON_DOTENV_DISABLED: '1', PYTHONUTF8: '1', LANG: 'en_US.UTF-8',
    TZ: 'America/New_York', OPENAI_COMPATIBLE_API_KEY: token, LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
  for (const name of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'FRED_API_KEY', 'ALPHA_VANTAGE_API_KEY',
    'SEC_EDGAR_USER_AGENT', 'TRADINGAGENTS_MARKET_VENDOR', 'TRADINGAGENTS_MARKET_FALLBACK', 'TRADINGAGENTS_NEWS_VENDOR',
    'TRADINGAGENTS_PUBLIC_CACHE_DIR']) {
    if (source[name]) environment[name] = source[name];
  }
  if (source.TRADINGAGENTS_HTTP_PROXY) {
    const proxy = new URL(source.TRADINGAGENTS_HTTP_PROXY);
    if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('研究代理须为 HTTP 或 HTTPS URL。');
    environment.HTTP_PROXY = environment.HTTPS_PROXY = source.TRADINGAGENTS_HTTP_PROXY;
    environment.http_proxy = environment.https_proxy = source.TRADINGAGENTS_HTTP_PROXY;
  }
  if (source.TRADINGAGENTS_MARKET_VENDOR === 'thinkorswim') {
    try {
    const url = new URL(source.TOS_MARKET_URL || 'http://127.0.0.1:8051');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) throw new Error('thinkorswim 行情接口须为本机 HTTP 地址。');
    const file = path.join(path.resolve(source.TOS_DATA_DIR || path.join(source.DATA_DIR || 'data', 'thinkorswim')), 'api-key.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('本地行情密钥权限无效。');
    const key = JSON.parse(fs.readFileSync(file, 'utf8')).key;
    if (typeof key !== 'string' || !key) throw new Error('本地行情密钥缺失。');
    environment.TOS_MARKET_URL = url.origin;
    environment.TOS_API_KEY = key;
    } catch {
      // A missing/expired local source must not stop the original vendor fallback.
      delete environment.TOS_API_KEY;
      delete environment.TOS_MARKET_URL;
    }
  }
  return environment;
}

export class PythonResearchRunner implements ResearchRunner {
  constructor(private readonly config: ResearchConfig, private readonly model: ModelConfig,
    private readonly quoteSource: ResearchQuoteSource = new ResearchQuotes().get) {}
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
    if (this.config.publicCacheDir) fs.mkdirSync(this.config.publicCacheDir, { recursive: true, mode: 0o700 });
    for (const filename of ['.env', '.env.enterprise']) fs.writeFileSync(path.join(input.directory, filename), '', { mode: 0o600 });
    progress('主动读取最新报价（嘉信优先，IB 备用）');
    let marketContext: ResearchMarketContext;
    try {
      marketContext = input.marketContext ?? await this.quoteSource(input.ticker, combined);
      combined.throwIfAborted();
    } catch (error) {
      if (signal.aborted) throw new Error('研究已取消。');
      if (deadline.aborted) throw new Error('研究超过运行时限，已停止；没有下单。');
      throw error;
    }
    fs.writeFileSync(path.join(input.directory, 'market-context.json'), JSON.stringify(marketContext), { mode: 0o600 });
    progress('读取最新持仓快照');
    const account = typeof input.account === 'function' ? await input.account() : input.account;
    combined.throwIfAborted();
    const bridge = await startModelBridge(this.model, { maxCalls: this.config.maxCalls, signal: combined, onCall: calls => progress('模型研究中', calls),
      onRetry: (code, seconds) => progress('模型连接暂时失败（' + code + '），等待 ' + seconds + ' 秒后重试'),
      onThrottle: seconds => progress('模型接口限流，等待 ' + seconds + ' 秒后重试') });
    try {
      return await new Promise<ResearchResult>((resolve, reject) => {
        const child = spawn(this.config.python, ['-I', this.config.worker], { cwd: input.directory,
          env: workerEnvironment(input.directory, bridge.token, { ...process.env,
            TRADINGAGENTS_PUBLIC_CACHE_DIR: this.config.publicCacheDir }), stdio: ['pipe', 'pipe', 'pipe'] });
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
              if (event.event === 'error') failure = researchWorkerFailure(event, input.ticker, bridge.token);
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
        child.stdin.end(JSON.stringify({ ticker: input.ticker, date: input.date, account, marketContext,
          bridgeUrl: bridge.url, model: this.model.name, maxTokens: this.model.maxTokens, timeoutSeconds: this.config.timeoutMs / 1000 + 5 }));
      });
    } finally { await bridge.close(); }
  }
}
