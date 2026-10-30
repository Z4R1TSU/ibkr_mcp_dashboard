import { Agent } from 'undici';

// Native fetch otherwise stops connecting after ~10s, regardless of the model's
// request deadline. Keep this pool specific to model traffic; research data has
// its own proxy. The caller's AbortSignal bounds connection, headers and body.
const dispatcher = new Agent({
  connectTimeout: 30000,
  autoSelectFamily: true,
  headersTimeout: 0,
  bodyTimeout: 0,
});

export const modelFetch: typeof fetch = (url, init) => {
  const options: RequestInit & { dispatcher: Agent } = { ...init, dispatcher };
  return fetch(url, options);
};
