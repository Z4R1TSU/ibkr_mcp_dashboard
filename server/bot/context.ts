import { getEncoding } from 'js-tiktoken';
import type { ModelMessage } from './model-protocol.js';

let encoder: ReturnType<typeof getEncoding> | undefined;
export function messageTokens(message: ModelMessage): number {
  encoder ??= getEncoding('o200k_base');
  return encoder.encode(message.content, [], []).length + 4;
}

/** Estimate input tokens; the provider's reported usage remains authoritative. */
export function prepareContext(system: ModelMessage, current: ModelMessage, history: ModelMessage[], budget: number) {
  let tokens = messageTokens(system) + messageTokens(current) + 3;
  if (tokens > budget) throw new ContextBudgetError();
  let start = history.length;
  while (start > 0) {
    const next = Math.max(0, start - 2);
    const size = history.slice(next, start).reduce((sum, message) => sum + messageTokens(message), 0);
    if (tokens + size > budget) break;
    tokens += size;
    start = next;
  }
  return { messages: [system, ...history.slice(start), current], estimatedInputTokens: tokens,
    historyMessages: history.length - start, omittedHistoryMessages: start, contextBudgetTokens: budget };
}

export class ContextBudgetError extends Error {
  constructor() { super('Current question and account context exceed the configured input budget'); }
}
