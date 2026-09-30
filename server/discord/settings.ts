import fs from 'node:fs';
import path from 'node:path';
import type { DiscordSettings } from '../../shared/discord.js';

export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function validateSettings(input: unknown): DiscordSettings {
  const value = input as Partial<DiscordSettings> | null;
  if (!value || typeof value.enabled !== 'boolean' || typeof value.applicationId !== 'string'
    || typeof value.startDate !== 'string') throw new Error('Discord 设置格式无效');
  const applicationId = value.applicationId.trim();
  const startDate = value.startDate.trim();
  if (applicationId && !/^\d{17,20}$/.test(applicationId)) throw new Error('Application ID 应为 17–20 位数字');
  if (startDate && (!validDate(startDate) || startDate > new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }))) throw new Error('入市日期须为有效的过去或今天日期');
  if (value.enabled && (!applicationId || !startDate)) throw new Error('开启前请填写 Application ID 和入市日期');
  if (value.capitalUsd !== undefined && (!Number.isFinite(value.capitalUsd) || value.capitalUsd! <= 0)) throw new Error('USD 本金须为大于 0 的数字');
  if (value.depositsCnh !== undefined && (!Number.isFinite(value.depositsCnh) || value.depositsCnh! < 0)) throw new Error('CNH 入金金额无效');
  return { enabled: value.enabled, applicationId, startDate,
    ...(value.capitalUsd === undefined ? {} : { capitalUsd: value.capitalUsd }),
    ...(value.depositsCnh === undefined ? {} : { depositsCnh: value.depositsCnh }),
    ...(typeof value.capitalConfirmedAt === 'string' && validDate(value.capitalConfirmedAt) ? { capitalConfirmedAt: value.capitalConfirmedAt } : {}),
  };
}

export class DiscordSettingsStore {
  private readonly file: string;
  private value: DiscordSettings;
  error: string | null = null;
  constructor(directory: string, startDate = '') {
    this.file = path.join(directory, 'discord.json');
    this.value = { enabled: false, applicationId: '', startDate: validDate(startDate) ? startDate : '' };
    if (fs.existsSync(this.file)) {
      try { this.value = validateSettings(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
      catch { this.error = 'Discord 设置无法读取，已暂停同步，请重新保存设置'; }
    }
  }
  get(): DiscordSettings { return { ...this.value }; }
  save(input: unknown): DiscordSettings {
    const value = validateSettings(input);
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.value = value;
    this.error = null;
    return this.get();
  }
}
