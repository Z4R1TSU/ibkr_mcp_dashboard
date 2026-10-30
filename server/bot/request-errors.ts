export const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

export function errorCode(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 3) return null;
  const error = value as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,59}$/.test(error.code)) return error.code;
  return errorCode(error.cause, depth + 1) ?? (Array.isArray(error.errors) ? error.errors.map(item => errorCode(item, depth + 1)).find(Boolean) ?? null : null);
}
