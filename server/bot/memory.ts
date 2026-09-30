import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { ModelMessage } from './model-protocol.js';

interface Turn { user: string; assistant: string }
export class ConversationMemory {
  private conversations: Record<string, Turn[]> = {};
  private readonly key: Buffer;
  private readonly file: string;
  constructor(directory: string, readonly maxTurns = 20, readonly maxChars = 200000) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyFile = path.join(directory, 'chat-memory.key');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    this.key = fs.readFileSync(keyFile);
    this.file = path.join(directory, 'chat-memory.enc');
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(saved.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
      this.conversations = JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]).toString());
    }
  }
  read(scope: string): ModelMessage[] {
    return (this.conversations[scope] ?? []).flatMap(turn => [
      { role: 'user' as const, content: turn.user }, { role: 'assistant' as const, content: turn.assistant },
    ]);
  }
  clear(scope: string): void { delete this.conversations[scope]; this.save(); }
  append(scope: string, user: string, assistant: string): void {
    const turns = [...(this.conversations[scope] ?? []), { user, assistant }];
    while (turns.length > 1 && (turns.length > this.maxTurns || turns.reduce((sum, t) => sum + t.user.length + t.assistant.length, 0) > this.maxChars)) turns.shift();
    const last = turns.at(-1)!;
    if (last.user.length + last.assistant.length > this.maxChars) {
      last.user = last.user.slice(0, Math.floor(this.maxChars / 2));
      last.assistant = last.assistant.slice(0, this.maxChars - last.user.length - 30) + '\n[较长回答的历史内容已截取]';
    }
    this.conversations[scope] = turns;
    this.save();
  }
  private save(): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(this.conversations), 'utf8'), cipher.final()]);
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
