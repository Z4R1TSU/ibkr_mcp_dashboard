import { randomUUID } from 'node:crypto';
import type { ModelConfig } from './config.js';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionMessage {
  role: ModelMessage['role'] | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface CompletionOptions {
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  response_format?: unknown;
}

export function modelRequest(config: ModelConfig, messages: CompletionMessage[], options: CompletionOptions = {}): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let url: string;
  let body: unknown;
  if (config.provider === 'aidp') {
    const address = new URL(config.baseUrl);
    address.searchParams.set('ak', config.apiKey);
    url = address.href;
    headers['X-TT-LOGID'] = randomUUID().replaceAll('-', '');
    body = {
      model: config.name, stream: false, max_tokens: config.maxTokens,
      messages: messages.map(({ content, ...message }) => ({ ...message, content: content === null ? [] : [{ type: 'text', text: content }] })),
      ...options,
    };
  } else {
    url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    headers.Authorization = 'Bearer ' + config.apiKey;
    body = { model: config.name, stream: false, store: false, messages, ...options };
  }
  return { url, init: {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
    headers, body: JSON.stringify(body),
  } };
}
