export interface BotConfig {
  enabled: boolean;
  cliPath: string;
  profile: string;
  ownerOpenId: string;
  botOpenId?: string;
  timeZone: string;
  publicUrl: string;
  dataDir: string;
}

export interface ModelConfig {
  provider: 'chat-completions' | 'aidp';
  baseUrl: string;
  apiKey: string;
  name: string;
  timeoutMs: number;
  maxTokens: number;
  contextTokens: number;
}

export function readBotConfig(env: NodeJS.ProcessEnv, app: { publicUrl: string; dataDir: string }): BotConfig {
  const enabled = env.FEISHU_ENABLED === 'true';
  if (env.FEISHU_ENABLED && !['true', 'false'].includes(env.FEISHU_ENABLED)) throw new Error('FEISHU_ENABLED must be true or false');
  const profile = env.FEISHU_PROFILE?.trim() ?? '';
  if (enabled && !/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Set FEISHU_PROFILE to a dedicated lark-cli profile');
  const ownerOpenId = env.FEISHU_OWNER_OPEN_ID?.trim() ?? '';
  if (ownerOpenId && !/^ou_[a-zA-Z0-9]+$/.test(ownerOpenId)) throw new Error('Invalid FEISHU_OWNER_OPEN_ID');
  const timeZone = env.FEISHU_TIMEZONE || 'Asia/Shanghai';
  new Intl.DateTimeFormat('en-CA', { timeZone }).format();
  const botOpenId = env.FEISHU_BOT_OPEN_ID?.trim() || '';
  if (botOpenId && !/^ou_[a-zA-Z0-9]+$/.test(botOpenId)) throw new Error('Invalid FEISHU_BOT_OPEN_ID');
  return { enabled, profile, ownerOpenId, botOpenId, timeZone, cliPath: env.FEISHU_CLI_PATH || 'lark-cli', ...app };
}

export function readModelConfig(env: NodeJS.ProcessEnv): ModelConfig {
  const provider = env.MODEL_PROVIDER || 'chat-completions';
  if (provider !== 'chat-completions' && provider !== 'aidp') throw new Error('MODEL_PROVIDER must be chat-completions or aidp');
  const maxTokens = Number(env.MODEL_MAX_TOKENS || 32768);
  const contextTokens = Number(env.MODEL_CONTEXT_TOKENS || 100000);
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 4096 || contextTokens > 1000000) throw new Error('MODEL_CONTEXT_TOKENS must be 4096–1000000');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw new Error('MODEL_MAX_TOKENS must be 1–32768');
  const timeoutMs = Number(env.MODEL_TIMEOUT_SECONDS || 300) * 1000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('MODEL_TIMEOUT_SECONDS must be 1–900');
  const value: ModelConfig = { provider, baseUrl: env.MODEL_BASE_URL?.trim() ?? '', apiKey: env.MODEL_API_KEY ?? '', name: env.MODEL_NAME?.trim() ?? '', timeoutMs, maxTokens, contextTokens };
  if (value.baseUrl) {
    const url = new URL(value.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('MODEL_BASE_URL must not contain credentials, query, or fragment');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Model endpoint requires HTTPS, except local models');
    if (provider === 'aidp' && url.href !== 'https://aidp.bytedance.net/api/modelhub/online/v2/crawl') throw new Error('AIDP requires the official crawl endpoint without query parameters');
  }
  return value;
}

export function readMemoryConfig(env: NodeJS.ProcessEnv) {
  const maxTurns = Number(env.MEMORY_MAX_TURNS || 20);
  const maxChars = Number(env.MEMORY_MAX_CHARS || 200000);
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000) throw new Error('MEMORY_MAX_TURNS must be 1–1000');
  if (!Number.isSafeInteger(maxChars) || maxChars < 1000 || maxChars > 5000000) throw new Error('MEMORY_MAX_CHARS must be 1000–5000000');
  return { maxTurns, maxChars };
}
