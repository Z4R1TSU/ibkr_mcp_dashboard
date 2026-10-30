import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrokerId } from '../../shared/broker-auth.js';

export interface LoginAlertIncident {
  id: string;
  detectedAt: string;
  sentAt: string | null;
  resolvedAt?: string;
}

export interface BotState {
  version: 1;
  profile: string;
  ownerOpenId: string;
  dailyTime: string | null;
  dailyTimeZone?: string;
  alerts: boolean;
  preferences: string;
  delivered: Record<string, number>;
  lastHealth: string | null;
  loginAlerts?: Partial<Record<BrokerId, LoginAlertIncident>>;
  groups?: import('./groups.js').GroupRule[];
}

export class BotStore {
  readonly state: BotState;
  private readonly file: string;
  private pairing?: { code: string; expires: number };
  private readonly pairingFile: string;

  constructor(directory: string, profile: string, ownerOpenId = '') {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'feishu-bot.json');
    this.pairingFile = path.join(directory, 'feishu-pairing.txt');
    this.state = { version: 1, profile, ownerOpenId, dailyTime: null, alerts: false, preferences: '', delivered: {}, lastHealth: null };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as BotState;
      if (saved.version !== 1 || saved.profile !== profile) throw new Error('Feishu state belongs to another profile');
      if (ownerOpenId && saved.ownerOpenId && saved.ownerOpenId !== ownerOpenId) throw new Error('Configured Feishu owner differs from the paired owner');
      Object.assign(this.state, saved);
      if (ownerOpenId) this.state.ownerOpenId = ownerOpenId;
    }
    if (!this.state.ownerOpenId) this.createPairing();
  }

  private createPairing(): void {
    this.pairing = { code: randomBytes(18).toString('base64url'), expires: Date.now() + 15 * 60000 };
    fs.writeFileSync(this.pairingFile, '绑定 ' + this.pairing.code + '\n', { mode: 0o600 });
    fs.chmodSync(this.pairingFile, 0o600);
  }

  pairingInfo(): { command: string; expiresAt: string } | null {
    if (this.state.ownerOpenId) return null;
    if (!this.pairing || this.pairing.expires <= Date.now()) this.createPairing();
    return { command: '绑定 ' + this.pairing!.code, expiresAt: new Date(this.pairing!.expires).toISOString() };
  }

  bind(openId: string, code: string): boolean {
    if (this.state.ownerOpenId || !this.pairing || this.pairing.expires <= Date.now()) return false;
    const expected = Buffer.from(this.pairing.code), actual = Buffer.from(code);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    this.state.ownerOpenId = openId;
    this.save();
    this.pairing = undefined;
    fs.rmSync(this.pairingFile, { force: true });
    return true;
  }

  delivered(key: string, now = Date.now()): boolean {
    return (this.state.delivered[key] ?? 0) > now - 7 * 86400000;
  }

  markDelivered(key: string, now = Date.now()): void {
    this.state.delivered[key] = now;
    this.save(now);
  }

  save(now = Date.now()): void {
    this.state.delivered = Object.fromEntries(Object.entries(this.state.delivered).filter(([, time]) => time > now - 7 * 86400000).slice(-3000));
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
