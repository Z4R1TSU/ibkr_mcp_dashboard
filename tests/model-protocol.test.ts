import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelConfig } from '../server/bot/config.js';
import { modelRequest } from '../server/bot/model-protocol.js';

test('AIDP uses the supplied endpoint, encoded ak, text arrays and a unique log ID', () => {
  const config = readModelConfig({
    MODEL_PROVIDER: 'aidp',
    MODEL_BASE_URL: 'https://aidp.bytedance.net/api/modelhub/online/v2/crawl',
    MODEL_API_KEY: 'test+&?key',
    MODEL_NAME: 'gpt-5.6-sol',
    MODEL_MAX_TOKENS: '500',
  });
  const messages = [{ role: 'user' as const, content: '1+1?' }];
  const request = modelRequest(config, messages);
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, config.baseUrl);
  assert.equal(url.searchParams.get('ak'), config.apiKey);
  const headers = new Headers(request.init.headers);
  assert.equal(headers.has('Authorization'), false);
  assert.match(headers.get('X-TT-LOGID')!, /^[a-f0-9]{32}$/);
  assert.notEqual(headers.get('X-TT-LOGID'), new Headers(modelRequest(config, messages).init.headers).get('X-TT-LOGID'));
  const body = JSON.parse(String(request.init.body));
  assert.deepEqual(body, { model: 'gpt-5.6-sol', stream: false, max_tokens: 500,
    messages: [{ role: 'user', content: [{ type: 'text', text: '1+1?' }] }] });
  assert.equal(request.init.redirect, 'error');
  assert.doesNotMatch(String(request.init.body), /test\+&\?key/);
});

test('AIDP configuration keeps credentials separate and rejects a different destination', () => {
  const base = { MODEL_PROVIDER: 'aidp', MODEL_NAME: 'gpt-5.6-sol' };
  assert.throws(() => readModelConfig({ ...base, MODEL_BASE_URL: 'https://other.example/crawl' }));
  assert.throws(() => readModelConfig({ ...base, MODEL_BASE_URL: 'https://aidp.bytedance.net/api/modelhub/online/v2/crawl?ak=secret' }));
  assert.throws(() => readModelConfig({ ...base, MODEL_MAX_TOKENS: '-1' }));
  assert.throws(() => readModelConfig({ ...base, MODEL_MAX_TOKENS: 'NaN' }));
});
