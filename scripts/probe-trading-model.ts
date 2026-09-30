import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readModelConfig } from '../server/bot/config.js';
import { modelRequest, type ModelMessage } from '../server/bot/model-protocol.js';
import { interpretModelResponse } from '../server/bot/model-response.js';

const config = readModelConfig(process.env);
if (!config.baseUrl || !config.apiKey || !config.name) throw new Error('Model configuration is incomplete');

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replaceAll(config.apiKey, '[redacted]')
    .replaceAll(encodeURIComponent(config.apiKey), '[redacted]')
    .replace(/([?&]ak=)[^\s&]+/g, '$1[redacted]')
    .slice(0, 500);
}

async function request(stage: string, messages: ModelMessage[], overrides: Record<string, unknown> = {}) {
  const outgoing = modelRequest(config, messages);
  const body = { ...JSON.parse(String(outgoing.init.body)), ...overrides };
  const response = await fetch(outgoing.url, { ...outgoing.init, body: JSON.stringify(body) });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(stage + ': HTTP ' + response.status + ' ' + safeError(result?.error?.message ?? result?.message ?? 'Request rejected'));
  if (!result?.choices?.[0]?.message) throw new Error(stage + ': Missing completion message');
  console.log(JSON.stringify({ stage, http: response.status, finishReason: result.choices[0].finish_reason, usage: result.usage }));
  return { result, body };
}

try {
  console.log(JSON.stringify({ provider: config.provider, model: config.name, accountDataSent: false }));
  const fixtureMessages: ModelMessage[] = [
    { role: 'system', content: 'This is a protocol compatibility test using fictional data only. Call read_fixture with fixture_id protocol-test, then return only the nonce from its result. Never invent the result.' },
    { role: 'user', content: 'Read the protocol-test fixture and return its nonce.' },
  ];
  const tools = [{ type: 'function', function: {
    name: 'read_fixture', description: 'Read a fictional protocol-test fixture; no network or account access.',
    parameters: { type: 'object', properties: { fixture_id: { type: 'string' } }, required: ['fixture_id'], additionalProperties: false },
    strict: true,
  } }];
  const first = await request('tool-call', fixtureMessages, {
    tools, tool_choice: { type: 'function', function: { name: 'read_fixture' } }, parallel_tool_calls: false,
  });
  const message = first.result.choices[0].message;
  const calls = message.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1 || typeof calls[0]?.id !== 'string'
    || calls[0]?.function?.name !== 'read_fixture' || JSON.parse(calls[0].function.arguments)?.fixture_id !== 'protocol-test') {
    throw new Error('tool-call: Expected one native read_fixture call with the requested fixture ID');
  }
  const nonce = randomUUID();
  const content = (text: string) => config.provider === 'aidp' ? [{ type: 'text', text }] : text;
  const second = await request('tool-result', fixtureMessages, {
    tools, tool_choice: 'none',
    messages: [
      ...first.body.messages,
      { role: 'assistant', content: content(interpretModelResponse(first.result).text), tool_calls: calls },
      { role: 'tool', tool_call_id: calls[0].id, content: content(JSON.stringify({ nonce })) },
    ],
  });
  if (interpretModelResponse(second.result).text !== nonce) throw new Error('tool-result: Model did not return the actual tool result');
  console.log(JSON.stringify({ test: 'native-tool-roundtrip', valid: true }));
  const structured = await request('structured-output', [
    { role: 'user', content: 'This is a fictional protocol test. Return JSON with status equal to verified and count equal to 7.' },
  ], { response_format: { type: 'json_schema', json_schema: {
    name: 'protocol_result', strict: true,
    schema: { type: 'object', properties: { status: { type: 'string', enum: ['verified'] }, count: { type: 'integer' } }, required: ['status', 'count'], additionalProperties: false },
  } } });
  const parsed = JSON.parse(interpretModelResponse(structured.result).text);
  if (parsed.status !== 'verified' || parsed.count !== 7 || Object.keys(parsed).length !== 2) throw new Error('structured-output: Schema result was not valid');
  console.log(JSON.stringify({ test: 'structured-output', valid: true }));
} catch (error) {
  console.error(JSON.stringify({ error: safeError(error), code: (error as { cause?: { code?: string } })?.cause?.code ?? null }));
  process.exitCode = 1;
}
