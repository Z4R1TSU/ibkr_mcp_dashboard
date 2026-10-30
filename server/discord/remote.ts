import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export class RemoteDiscord {
  private readonly authorization: Buffer;
  private seenAt = 0;
  private value = { connected: false, lastSentAt: null as string | null, error: null as string | null };
  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'discord-sync-token');
    if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid Discord sync token');
    this.authorization = Buffer.from('Bearer ' + token);
  }
  authorized(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const actual = Buffer.from(value);
    return actual.length === this.authorization.length && timingSafeEqual(actual, this.authorization);
  }
  report(input: unknown, now = Date.now()): void {
    const value = input as Partial<typeof this.value> | null;
    if (!value || typeof value.connected !== 'boolean'
      || !(value.error === null || typeof value.error === 'string')
      || !(value.lastSentAt === null || typeof value.lastSentAt === 'string' && Number.isFinite(Date.parse(value.lastSentAt)) && Date.parse(value.lastSentAt) <= now + 60000)) throw new Error('Invalid Discord sync status');
    this.seenAt = now;
    this.value = { connected: value.connected, lastSentAt: value.lastSentAt, error: value.error?.slice(0, 200) ?? null };
  }
  reset(): void {
    this.seenAt = 0;
    this.value = { connected: false, lastSentAt: null, error: null };
  }
  status(now = Date.now()) {
    const recent = this.seenAt > 0 && now - this.seenAt < 90000;
    return { connected: recent && this.value.connected, lastSentAt: this.value.lastSentAt,
      error: recent ? this.value.error : '等待 Mac 同步程序连接' };
  }
}
