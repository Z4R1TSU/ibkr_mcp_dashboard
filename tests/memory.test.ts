import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationMemory } from '../server/bot/memory.js';

test('memory persists encrypted and isolates chats', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-memory-test-'));
  try {
    const memory = new ConversationMemory(directory);
    memory.append('dm:owner', 'PRIVATE_QUESTION', 'PRIVATE_ANSWER');
    memory.append('group:one', 'group question', 'group answer');
    const restored = new ConversationMemory(directory);
    assert.equal(restored.read('dm:owner')[0].content, 'PRIVATE_QUESTION');
    assert.doesNotMatch(JSON.stringify(restored.read('group:one')), /PRIVATE/);
    assert.deepEqual(restored.read('group:two'), []);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'chat-memory.enc'), 'utf8'), /PRIVATE_QUESTION/);
    assert.equal(fs.statSync(path.join(directory, 'chat-memory.enc')).mode & 0o777, 0o600);
    restored.clear('group:one');
    assert.deepEqual(new ConversationMemory(directory).read('group:one'), []);
    assert.equal(restored.read('dm:owner').length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('memory retains at most 20 complete turns and bounds long context', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-memory-limit-'));
  try {
    const memory = new ConversationMemory(directory);
    for (let i = 0; i < 25; i++) memory.append('dm:owner', 'question ' + i, 'answer ' + i);
    assert.equal(memory.read('dm:owner').length, 40);
    assert.equal(memory.read('dm:owner')[0].content, 'question 5');
    const small = new ConversationMemory(directory, 20, 100);
    small.append('group:long', 'q'.repeat(80), 'a'.repeat(200));
    assert.ok(small.read('group:long').map(m => m.content).join('').length <= 100);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
