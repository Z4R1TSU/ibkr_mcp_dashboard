import fs from 'node:fs';
import path from 'node:path';
import { completedDay } from './daily-performance.js';

export interface PerformanceDay {
  date: string; previousDate: string;
  startNav: number; endNav: number; returnPct: number;
  fetchedAt: string; source: 'ib-pa' | 'daily-report';
}
const iso = (v: unknown) => typeof v === 'string' && /^\d{8}$/.test(v) ? v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6) : String(v);
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const validDay = (d: PerformanceDay) => validDate(d?.date) && validDate(d?.previousDate) && d.previousDate < d.date
  && [d.startNav, d.endNav, d.returnPct].every(Number.isFinite) && d.startNav >= 0 && d.endNav >= 0 && d.returnPct >= -100;

export class PerformanceStore {
  private accountId = '';
  private currency = '';
  private days: Record<string, PerformanceDay> = {};
  private file?: string;
  private providerLatest: string | null = null;
  private importedReports = false;
  constructor(private readonly directory?: string) {
    if (!directory) return;
    this.file = path.join(directory, 'performance-history.json');
    if (fs.existsSync(this.file)) {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (stored.version !== 1 || typeof stored.accountId !== 'string' || typeof stored.currency !== 'string') throw new Error('业绩历史文件格式错误');
      this.accountId = stored.accountId; this.currency = stored.currency;
      this.importedReports = true;
      this.days = Object.fromEntries(Object.entries(stored.days ?? {}).filter(([date, value]) => validDay(value as PerformanceDay) && (value as PerformanceDay).date === date)) as Record<string, PerformanceDay>;
    } else {
      const latest = path.join(directory, 'pa-performance-latest.json');
      if (fs.existsSync(latest)) {
        try {
          const saved = JSON.parse(fs.readFileSync(latest, 'utf8'));
          this.ingest(saved.data, new Date(saved.fetchedAt));
        } catch { /* A fresh IB response can rebuild an unusable legacy capture. */ }
      }
    }
  }
  private importReports() {
    if (!this.directory) return;
    const folder = path.join(this.directory, 'daily-reports');
    if (!fs.existsSync(folder)) return;
    for (const name of fs.readdirSync(folder).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
      let saved: any;
      try { saved = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')); } catch { continue; }
      const a = saved.facts?.account;
      if (a?.currency !== this.currency || a?.measure !== 'TWR') continue;
      const day: PerformanceDay = { ...a, fetchedAt: saved.facts.generatedAt, source: 'daily-report' };
      if (validDay(day) && !this.days[day.date]) this.days[day.date] = day;
    }
  }
  ingest(input: unknown, now = new Date()): unknown {
    const data = input as any;
    const entries = Object.entries(data?.accounts ?? {});
    if (data?.portfolio_measure !== 'TWR' || entries.length !== 1) throw new Error('业绩账户范围或口径不明确');
    const [id, account] = entries[0] as [string, any];
    if (typeof account.base_currency !== 'string') throw new Error('业绩币种缺失');
    if (this.accountId && (this.accountId !== id || this.currency !== account.base_currency)) {
      this.days = {}; this.importedReports = true;
    }
    this.accountId = id; this.currency = account.base_currency;
    if (!this.importedReports) { this.importReports(); this.importedReports = true; }
    const updated = new Set<string>();
    const periods = (Object.values(account.periods ?? {}) as any[]).sort((a, b) => (b.dates?.length ?? 0) - (a.dates?.length ?? 0));
    for (const p of periods) {
      if (p.frequency !== 'D' || !Array.isArray(p.dates) || p.dates.length !== p.nav?.length || p.dates.length !== p.cps?.length) continue;
      const dates = p.dates.map(iso) as string[];
      if (dates.some((d, i) => !validDate(d) || (i > 0 && d <= dates[i - 1]))) continue;
      for (let i = 0; i < dates.length; i++) {
        const date = dates[i], before = i ? p.cps[i - 1] : 0, after = p.cps[i];
        if (updated.has(date) || !completedDay(date, now) || !Number.isFinite(before) || before <= -1 || !Number.isFinite(after)) continue;
        const day: PerformanceDay = { date, previousDate: i ? dates[i - 1] : iso(p.start_date),
          startNav: i ? p.nav[i - 1] : p.start_nav, endNav: p.nav[i],
          returnPct: ((1 + after) / (1 + before) - 1) * 100, fetchedAt: now.toISOString(), source: 'ib-pa' };
        if (!validDay(day)) continue;
        this.days[date] = day; updated.add(date);
      }
    }
    this.providerLatest = [...updated].sort().at(-1) ?? null;
    if (this.file) {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, accountId: this.accountId, currency: this.currency, days: this.days }), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    }
    return this.view(updated.size === 0);
  }
  view(offline = false): unknown {
    const rows = Object.values(this.days).sort((a, b) => a.date.localeCompare(b.date));
    if (!this.accountId || !rows.length) throw new Error('尚无可用的本地业绩历史');
    let chain: PerformanceDay[] = [];
    for (const day of rows) {
      if (chain.length && day.previousDate !== chain.at(-1)!.date) chain = [];
      chain.push(day);
    }
    let factor = 1;
    const cps = chain.map(day => { factor *= 1 + day.returnPct / 100; return factor - 1; });
    return { portfolio_measure: 'TWR', accounts: { [this.accountId]: { base_currency: this.currency, periods: {
      LOCAL: { frequency: 'D', start_date: chain[0].previousDate, start_nav: chain[0].startNav,
        dates: chain.map(d => d.date), nav: chain.map(d => d.endNav), cps },
    } } }, local_archive: { providerLatest: this.providerLatest, latestDate: rows.at(-1)!.date,
      offline, records: rows.length, closingDays: rows.slice(-3) } };
  }
}
