export interface ModelResponseInfo {
  text: string;
  finishReason: string | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  error: 'length' | 'empty' | 'format' | null;
}

export function interpretModelResponse(input: unknown): ModelResponseInfo {
  const data = input as any;
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content.trim()
    : Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').trim() : '';
  const refusal = typeof choice?.message?.refusal === 'string' ? choice.message.refusal.trim() : '';
  const result = text || refusal;
  const reason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  return {
    text: result,
    finishReason: reason,
    completionTokens: Number.isFinite(data?.usage?.completion_tokens) ? data.usage.completion_tokens : null,
    reasoningTokens: Number.isFinite(data?.usage?.completion_tokens_details?.reasoning_tokens) ? data.usage.completion_tokens_details.reasoning_tokens : null,
    error: result ? null : !choice ? 'format' : reason === 'length' ? 'length' : 'empty',
  };
}

export class ModelReplyError extends Error {
  constructor(readonly reason: 'length' | 'empty' | 'format') { super(reason); }
}
