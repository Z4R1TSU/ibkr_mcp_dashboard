import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliTransport } from '../server/bot/transport.js';
import { splitMarkdown } from '../server/bot/markdown.js';

test('markdown chunks preserve Unicode, paragraphs and fenced code', () => {
  const paragraph = '**重点**\n\n' + '🙂中文'.repeat(1800);
  const chunks = splitMarkdown(paragraph);
  assert.equal(chunks.join(''), paragraph);
  assert.ok(chunks.every(c => Array.from(c).length <= 3000));
  const code = splitMarkdown('```text\n' + '一行代码\n'.repeat(1200) + '```\n\n结束');
  assert.ok(code.length > 1);
  for (const chunk of code) assert.equal((chunk.match(/^```/gm) ?? []).length, 2);
  assert.ok(code.every(c => Array.from(c).length <= 3000));
});

function fakeCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-transport-'));
  const cliPath = path.join(dir, 'fake-cli.cjs');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(cliPath, '#!' + process.execPath + '\n' +
    'const fs = require("node:fs"); const args = process.argv.slice(2);\n' +
    'fs.appendFileSync(' + JSON.stringify(log) + ', JSON.stringify(args) + "\\n");\n' +
    'process.stdout.write(JSON.stringify({ok: !args.includes("fail")}));\n', { mode: 0o700 });
  return { dir, cliPath, read: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) };
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test('CLI uses markdown, native cards and receipt reactions with stable deduplication keys', async () => {
  const f = fakeCli();
  try {
    const config = { enabled: true, profile: 'test', cliPath: f.cliPath, ownerOpenId: 'ou_owner', publicUrl: 'http://127.0.0.1:8048', dataDir: f.dir, timeZone: 'Asia/Shanghai' };
    const transport = new CliTransport(config);
    const text = '# 标题\n\n**加粗**\n\n' + '内容\n'.repeat(1800);
    await transport.send('ou_owner', text, 'same');
    const first = f.read();
    await transport.send('ou_owner', text, 'same');
    assert.deepEqual(f.read().slice(first.length), first);
    assert.ok(first.every(call => call.includes('--markdown') && !call.includes('--text')));
    assert.equal(first.map(call => flag(call, '--markdown')).join(''), text);
    assert.equal(new Set(first.map(call => flag(call, '--idempotency-key'))).size, first.length);
    const card = { schema: '2.0', body: { elements: [] } };
    await transport.sendCard('oc_test', card, 'card');
    let call = f.read().at(-1)!;
    assert.equal(flag(call, '--chat-id'), 'oc_test');
    assert.equal(flag(call, '--msg-type'), 'interactive');
    assert.deepEqual(JSON.parse(flag(call, '--content')), card);
    await transport.acknowledge('om_message');
    call = f.read().at(-1)!;
    assert.deepEqual(JSON.parse(flag(call, '--params')), { message_id: 'om_message' });
    assert.equal(JSON.parse(flag(call, '--data')).reaction_type.emoji_type, 'Get');
    const failing = new CliTransport({ ...config, profile: 'fail' });
    await failing.acknowledge('om_message');
    assert.match(failing.status.reactionError!, /im:message.reactions:write_only/);
    await assert.rejects(() => failing.send('ou_owner', 'fail', 'failure'));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
