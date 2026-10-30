import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareContext, ContextBudgetError } from '../server/bot/context.js';
import { readMemoryConfig, readModelConfig } from '../server/bot/config.js';
import type { ModelMessage } from '../server/bot/model-protocol.js';

const system: ModelMessage = { role: 'system', content: 'Keep the account facts accurate.' };
const current: ModelMessage = { role: 'user', content: 'What did we discuss?' };
test('100k input budget retains conversations beyond twenty turns', () => {
  const history: ModelMessage[] = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'Conversation ' + i + ' 中文🙂 '.repeat(20) }));
  const result = prepareContext(system, current, history, 100000);
  assert.equal(result.historyMessages, 80);
  assert.equal(result.omittedHistoryMessages, 0);
  assert.deepEqual(result.messages, [system, ...history, current]);
  assert.equal(readModelConfig({}).contextTokens, 100000);
  assert.deepEqual(readMemoryConfig({ MEMORY_MAX_TURNS: '1000', MEMORY_MAX_CHARS: '2000000' }), { maxTurns: 1000, maxChars: 2000000 });
});

test('budgeting preserves complete recent pairs and never truncates the current question', () => {
  const history: ModelMessage[] = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'Message ' + i + ' 中文🙂 '.repeat(20) }));
  const result = prepareContext(system, current, history, 500);
  assert.ok(result.omittedHistoryMessages > 0);
  assert.equal(result.omittedHistoryMessages % 2, 0);
  assert.ok(result.estimatedInputTokens <= 500);
  assert.deepEqual(result.messages, [system, ...history.slice(result.omittedHistoryMessages), current]);
  assert.throws(() => prepareContext(system, { role: 'user', content: 'too long '.repeat(1000) }, [], 100), ContextBudgetError);
});

test('input budget counts tokens instead of characters and treats special-token text as input', () => {
  const history: ModelMessage[] = [{ role: 'user', content: 'hello '.repeat(50) }, { role: 'assistant', content: 'hello '.repeat(50) }];
  assert.equal(prepareContext(system, current, history, 180).omittedHistoryMessages, 0);
  assert.doesNotThrow(() => prepareContext(system, { role: 'user', content: '<|endoftext|> 中文🙂' }, [], 1000));
});
