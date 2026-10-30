import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PortfolioBot } from '../server/bot/service.js';
import { BotStore } from '../server/bot/store.js';
import { splitMarkdown } from '../server/bot/markdown.js';
import { readModelConfig } from '../server/bot/config.js';
import { CompatibleModel } from '../server/bot/model.js';
import { ResearchJobs, hasResearchRating } from '../server/research/jobs.js';
import { PythonResearchRunner, researchConfig, type ResearchRunner, type ResearchResult } from '../server/research/runner.js';
import type { DashboardState } from '../shared/types.js';

const ticker = (process.argv[2] || 'GOOG').toUpperCase();
if (!/^[A-Z][A-Z0-9.-]{0,19}$/.test(ticker) || ticker.includes('..')) throw new Error('Invalid ticker');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-delivery-'));
const modelConfig = readModelConfig(process.env);
const native = new PythonResearchRunner(researchConfig(process.env), modelConfig);
if (native.unavailable()) throw new Error(native.unavailable()!);
let jobDirectory = '', calls = 0;
const runner: ResearchRunner = { modelName: native.modelName, unavailable: () => native.unavailable(),
  run: (input, signal, progress) => {
    jobDirectory = input.directory;
    return native.run(input, signal, (stage, count) => {
      if (count !== undefined) calls = count;
      console.log(JSON.stringify({ stage, calls }));
      progress(stage, count);
    });
  } };
const jobs = new ResearchJobs(directory, runner);
const finished = Promise.withResolvers<void>();
const deliveries: { key: string; text: string; chunks: string[] }[] = [];
// Exercise the real bot and markdown pipeline with a local recording transport.
// This script never constructs CliTransport or sends a message to a person.
const transport = { send: async (_recipient: string, text: string, key: string) => {
  deliveries.push({ key, text, chunks: splitMarkdown(text) });
  if (key.startsWith('research-result:')) finished.resolve();
} };
const state = { snapshot: null, quotes: {}, history: [], status: { connected: false, stale: true } } as DashboardState;
const config = { enabled: true, profile: 'research-verification', cliPath: 'unused',
  ownerOpenId: 'ou_verification', botOpenId: 'ou_testbot', dataDir: directory,
  timeZone: 'Asia/Shanghai', publicUrl: 'http://127.0.0.1:8048' };
const bot = new PortfolioBot(config, new BotStore(directory, config.profile, config.ownerOpenId),
  { view: () => state, refresh: async () => {} }, transport, new CompatibleModel(modelConfig), undefined, jobs);
let id = 0;
const message = (content: string) => ({ sender_id: config.ownerOpenId, sender_type: 'user', chat_type: 'p2p',
  message_type: 'text', message_id: 'om_verify' + ++id, create_time: String(Date.now()), content });
process.once('SIGINT', () => void bot.stop());
console.log(JSON.stringify({ directory, ticker, accountReads: 0, realMessagesSent: 0 }));
try {
  await bot.receive(message('/research ' + ticker));
  await finished.promise;
  await new Promise(resolve => setImmediate(resolve));
  const file = path.join(jobDirectory, 'result.json');
  if (!fs.existsSync(file)) throw new Error('Research failed; inspect saved job status');
  const result = JSON.parse(fs.readFileSync(file, 'utf8')) as ResearchResult;
  const notification = deliveries.find(row => row.key.startsWith('research-result:'))!;
  await bot.receive(message('/research status'));
  const status = deliveries.at(-1)!.text;
  await bot.receive(message('/research report'));
  const returned = deliveries.at(-1)!;
  const checks = { rated: hasResearchRating(result.rating),
    notificationRating: notification.chunks.some(chunk => chunk.includes('研究评级：' + result.rating)),
    savedEqualsReturned: returned.text === (result.messageReport ?? result.report),
    returnedRating: returned.chunks.some(chunk => chunk.includes('研究评级：' + result.rating)),
    statusShowsRating: status.includes('研究评级：' + result.rating),
    noUnresolvedReferences: !result.report.includes('[[price:'),
    validationPassed: result.validation?.status !== 'blocked' };
  fs.writeFileSync(path.join(directory, 'delivery-verification.json'), JSON.stringify({
    checks, rating: result.rating, calls, jobDirectory, validation: result.validation,
    summaryChunks: notification.chunks.length, reportChunks: returned.chunks.length,
    accountReads: 0, realMessagesSent: 0,
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'delivery-payloads.json'), JSON.stringify(deliveries), { mode: 0o600 });
  console.log(JSON.stringify({ checks, rating: result.rating, calls, directory, jobDirectory }));
  assert.ok(Object.values(checks).every(Boolean), 'Research delivery acceptance failed');
} finally {
  await bot.stop();
}
