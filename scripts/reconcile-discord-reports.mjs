import fs from 'node:fs';
import path from 'node:path';
import { config } from '../dist/server/config.js';

const file = path.join(config.dataDir, 'discord-daily-snapshots.json');
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
const history = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'performance-history.json'), 'utf8'));
const scope = JSON.stringify([history.accountId, history.currency]);
const keyOf = entry => JSON.stringify([entry.scope, entry.day.date]);
const records = new Map(saved.records.map(entry => [keyOf(entry), entry]));
const candidates = new Map((saved.candidates ?? []).map(entry => [keyOf(entry), entry]));
const now = new Date(), changes = [];
const folder = path.join(config.dataDir, 'daily-reports');
for (const name of fs.readdirSync(folder).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
  const facts = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')).facts;
  const a = facts?.account, observed = Date.parse(facts?.accountAsOf ?? facts?.generatedAt);
  const cutoff = Date.parse(facts?.date + 'T04:00:00Z') + 86400000;
  if (!a || a.date !== facts.date || a.currency !== history.currency || a.measure !== 'TWR'
    || facts.accountId && facts.accountId !== history.accountId || !Number.isFinite(observed)
    || observed > cutoff || observed > now.getTime() || ![a.returnPct, a.startNav, a.endNav].every(Number.isFinite)) continue;
  const basis = history.days[a.date];
  if (!basis || Math.abs(basis.startNav - a.startNav) > 0.01) throw new Error('日报账户基准无法核对：' + a.date);
  const key = JSON.stringify([scope, a.date]), old = records.get(key) ?? candidates.get(key);
  if (old?.day.source === 'feishu-report') continue;
  const sealed = now.getTime() >= cutoff;
  const entry = { scope, day: { date: a.date, previousDate: a.previousDate, currency: a.currency,
    returnPct: a.returnPct, startNav: a.startNav, endNav: a.endNav,
    sourceFetchedAt: facts.accountAsOf ?? facts.generatedAt, capturedAt: now.toISOString(),
    source: 'feishu-report', sealed, cutoffAt: new Date(cutoff).toISOString() } };
  (sealed ? records : candidates).set(key, entry);
  if (sealed) candidates.delete(key); else records.delete(key);
  changes.push({ date: a.date, from: old?.day.returnPct ?? null, to: a.returnPct, sealed });
}
console.log(JSON.stringify({ apply: process.argv.includes('--apply'), changes }));
if (process.argv.includes('--apply') && changes.length) {
  const backup = file + '.before-feishu-' + Date.now();
  fs.copyFileSync(file, backup); fs.chmodSync(backup, 0o600);
  fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 2, records: [...records.values()], candidates: [...candidates.values()] }), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  console.log('旧记录备份：' + backup);
}
