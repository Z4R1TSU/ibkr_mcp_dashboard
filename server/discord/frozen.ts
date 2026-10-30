import fs from 'node:fs';
import path from 'node:path';
import type { FrozenPresenceDay } from '../../shared/discord.js';
import { completedDay } from '../daily-performance.js';
import type { DailyFacts } from '../daily-data.js';
import { isUsEquityTradingDate } from '../us-market-calendar.js';

function scopeOf(raw: any): { scope: string; currency: string } | null {
  const entries = Object.entries(raw?.accounts ?? {});
  if (raw?.portfolio_measure !== 'TWR' || entries.length !== 1) return null;
  const [id, account] = entries[0] as [string, any];
  if (typeof account.base_currency !== 'string') return null;
  return { scope: JSON.stringify([id, account.base_currency]), currency: account.base_currency };
}

export function dailyCutoff(date: string): number {
  // Noon in Beijing on the calendar day after the US trading date; DST-independent.
  return Date.parse(date + 'T04:00:00Z') + 86400000;
}

type RecordValue = { scope: string; day: FrozenPresenceDay };
export class FrozenPresenceStore {
  private records = new Map<string, RecordValue>();
  private file?: string;
  private candidates = new Map<string, RecordValue>();
  constructor(directory?: string) {
    if (!directory) return;
    this.file = path.join(directory, 'discord-daily-snapshots.json');
    if (!fs.existsSync(this.file)) return;
    const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (![1, 2].includes(saved.version) || !Array.isArray(saved.records)) throw new Error('Discord 固定快照文件格式错误');
    for (const [target, entries] of [[this.records, saved.records], [this.candidates, saved.candidates ?? []]] as const) {
      if (!Array.isArray(entries)) throw new Error('固定快照候选记录格式错误');
      for (const entry of entries as RecordValue[]) {
        const d = entry.day;
        if (typeof entry.scope !== 'string' || !d || !isUsEquityTradingDate(d.date)
          || typeof d.currency !== 'string' || ![d.returnPct, d.startNav, d.endNav].every(Number.isFinite)
          || d.returnPct < -100 || d.startNav < 0 || d.endNav < 0
          || !Number.isFinite(Date.parse(d.sourceFetchedAt)) || !Number.isFinite(Date.parse(d.capturedAt))) {
          throw new Error('Discord 固定快照记录无效');
        }
        const key = JSON.stringify([entry.scope, d.date]);
        if (target.has(key)) throw new Error('Discord 固定快照日期重复');
        target.set(key, entry);
      }
    }
  }
  private save(records: Map<string, RecordValue>, candidates: Map<string, RecordValue>): void {
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 2,
        records: [...records.values()], candidates: [...candidates.values()] }), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    }
    this.records = records;
    this.candidates = candidates;
  }
  private seal(now: Date): void {
    const records = new Map(this.records), candidates = new Map(this.candidates);
    for (const [key, value] of candidates) {
      if (value.day.source !== 'feishu-report' && now.getTime() < dailyCutoff(value.day.date)) continue;
      if (!records.has(key)) records.set(key, { scope: value.scope,
        day: { ...value.day, sealed: true, capturedAt: now.toISOString() } });
      candidates.delete(key);
    }
    if (candidates.size !== this.candidates.size) this.save(records, candidates);
  }
  get(raw: unknown, date: string, now = new Date()): FrozenPresenceDay | null {
    this.seal(now);
    const scope = scopeOf(raw);
    const key = scope && JSON.stringify([scope.scope, date]);
    const value = key && this.records.get(key);
    return value ? { ...value.day } : null;
  }
  latest(raw: unknown, through: string, now = new Date()): FrozenPresenceDay | null {
    this.seal(now);
    const scope = scopeOf(raw);
    const value = scope && [...this.records.values()].filter(entry => entry.scope === scope.scope && entry.day.date <= through)
      .sort((a, b) => b.day.date.localeCompare(a.day.date))[0];
    return value ? { ...value.day } : null;
  }
  history(raw: unknown, now = new Date()): FrozenPresenceDay[] {
    this.seal(now);
    const scope = scopeOf(raw);
    return scope ? [...this.records.values()].filter(entry => entry.scope === scope.scope)
      .map(entry => ({ ...entry.day })).sort((a, b) => a.date.localeCompare(b.date)) : [];
  }
  applyFacts(facts: DailyFacts, now = new Date()): DailyFacts {
    this.seal(now);
    if (!facts.accountId) return facts;
    const scope = JSON.stringify([facts.accountId, facts.account.currency]);
    const key = JSON.stringify([scope, facts.date]);
    const saved = this.records.get(key) ?? (this.candidates.get(key)?.day.source === 'feishu-report' ? this.candidates.get(key) : undefined);
    if (!saved) return facts;
    const d = saved.day, navChange = d.endNav - d.startNav;
    return { ...facts, accountAsOf: d.sourceFetchedAt, account: { ...facts.account, date: d.date, currency: d.currency,
      previousDate: d.previousDate ?? facts.account.previousDate, startNav: d.startNav, endNav: d.endNav,
      navChange, returnPct: d.returnPct, measure: 'TWR',
      flowMismatch: Math.abs(navChange - d.startNav * d.returnPct / 100) > Math.max(0.05, Math.abs(d.startNav) * 1e-7) } };
  }
  recordReport(facts: DailyFacts, now = new Date()): DailyFacts {
    const a = facts.account, observed = Date.parse(facts.accountAsOf ?? facts.generatedAt);
    if (!facts.accountId || a.measure !== 'TWR' || a.date !== facts.date || !isUsEquityTradingDate(a.date)
      || ![a.returnPct, a.startNav, a.endNav].every(Number.isFinite) || a.returnPct! < -100
      || a.startNav < 0 || a.endNav < 0 || !Number.isFinite(observed) || observed > now.getTime()
      || !completedDay(a.date, new Date(observed))) throw new Error('日报账户或收益快照信息不完整');
    const scope = JSON.stringify([facts.accountId, a.currency]), key = JSON.stringify([scope, a.date]);
    if (this.records.has(key) || this.candidates.get(key)?.day.source === 'feishu-report') return this.applyFacts(facts, now);
    if (observed > dailyCutoff(a.date)) {
      this.seal(now);
      if (!this.records.has(key)) throw new Error('北京时间 12:00 前未取得该日收益，不能用午后数据补写昨日快照');
      return this.applyFacts(facts, now);
    }
    const next = new Map(this.candidates);
    next.set(key, { scope, day: { date: a.date, currency: a.currency, previousDate: a.previousDate,
      returnPct: a.returnPct!, startNav: a.startNav, endNav: a.endNav,
      sourceFetchedAt: facts.accountAsOf ?? facts.generatedAt, capturedAt: now.toISOString(), cutoffAt: new Date(dailyCutoff(a.date)).toISOString(),
      source: 'feishu-report', sealed: false } });
    this.save(this.records, next);
    return this.applyFacts(facts, now);
  }
  capture(raw: unknown, now: Date): void {
    const scope = scopeOf(raw);
    const rows = (raw as any)?.local_archive?.closingDays;
    if (!scope || !Array.isArray(rows)) return;
    const next = new Map(this.candidates);
    let changed = false;
    for (const row of rows) {
      const observed = Date.parse(row?.fetchedAt);
      if (!isUsEquityTradingDate(row?.date) || !Number.isFinite(observed) || observed > now.getTime()
        || observed > dailyCutoff(row.date) || !completedDay(row.date, new Date(observed))
        || ![row.returnPct, row.startNav, row.endNav].every(Number.isFinite)
        || row.returnPct < -100 || row.startNav < 0 || row.endNav < 0) continue;
      const key = JSON.stringify([scope.scope, row.date]);
      const old = next.get(key);
      if (this.records.has(key) || old?.day.source === 'feishu-report'
        || old && Date.parse(old.day.sourceFetchedAt) >= observed) continue;
      const day: FrozenPresenceDay = { date: row.date, currency: scope.currency, returnPct: row.returnPct,
        startNav: row.startNav, endNav: row.endNav, sourceFetchedAt: row.fetchedAt, capturedAt: now.toISOString(),
        previousDate: row.previousDate, source: 'noon-cutoff', sealed: false, cutoffAt: new Date(dailyCutoff(row.date)).toISOString() };
      next.set(key, { scope: scope.scope, day });
      changed = true;
    }
    if (changed) this.save(this.records, next);
    this.seal(now);
  }
}
