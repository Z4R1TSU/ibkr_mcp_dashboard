import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from './config.js';

export interface VaultData {
  admin?: { salt: string; hash: string };
  oauth?: {
    client?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    expiresAt?: number;
    verifier?: string;
    state?: string;
    stateExpiresAt?: number;
    authorizationUrl?: string;
  };
}

export class Vault {
  private readonly key: Buffer;
  private readonly file: string;
  private value: VaultData;

  constructor(readonly directory = config.dataDir) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const keyFile = path.join(directory, 'vault.key');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = fs.readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('Invalid vault key');
    this.file = path.join(directory, 'vault.enc');
    this.value = {};
    if (fs.existsSync(this.file)) {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(stored.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
      this.value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString('utf8'));
    }
  }

  get(): VaultData { return this.value; }

  update(change: (value: VaultData) => void): void {
    change(this.value);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(this.value), 'utf8'), cipher.final()]);
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  ensureAdmin(): void {
    if (this.value.admin) return;
    const password = randomBytes(18).toString('base64url');
    this.setPassword(password);
    fs.writeFileSync(path.join(this.directory, 'initial-password.txt'), password + '\n', { mode: 0o600, flag: 'wx' });
  }

  setPassword(password: string): void {
    if (password.length < 12 || password.length > 256) throw new Error('密码必须为 12–256 个字符');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    this.update(value => { value.admin = { salt, hash }; });
  }

  checkPassword(password: unknown): boolean {
    if (typeof password !== 'string' || password.length > 256 || !this.value.admin) return false;
    const candidate = scryptSync(password, this.value.admin.salt, 64);
    return timingSafeEqual(candidate, Buffer.from(this.value.admin.hash, 'hex'));
  }
}
