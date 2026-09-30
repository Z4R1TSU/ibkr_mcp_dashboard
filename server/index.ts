import { config } from './config.js';
import { Vault } from './vault.js';
import { IbkrClient, IbkrOAuth } from './ibkr.js';
import { Collector } from './collector.js';
import { createApp } from './app.js';
import { createBot } from './bot/index.js';
import { ForexHistory } from './forex.js';
import { DailyData } from './daily-data.js';
import { PerformanceSource } from './performance-source.js';
import { PresenceData } from './discord/data.js';
import { createDiscord } from './discord/index.js';

const vault = new Vault();
if (config.accessMode === 'password') vault.ensureAdmin();
const client = new IbkrClient(new IbkrOAuth(vault));
const collector = new Collector(client);
const forex = new ForexHistory(client);
const performance = new PerformanceSource(client, config.dataDir);
const daily = new DailyData(client, performance);
const discord = createDiscord(config.dataDir, new PresenceData(() => collector.view(), () => performance.get(), () => daily.latestCompletedDate(), () => daily.previousTradingDate()), () => forex.capitalPreview());
const bot = createBot({ view: () => collector.view(), refresh: () => collector.refresh(), forex: () => forex.get(), forexAnalysis: question => forex.analysis(question), dailyFacts: () => daily.get(collector.view()) }, config);
const server = createApp(client, collector, config, () => bot.status(), bot.controls, discord.controls).listen(config.port, config.host, () => {
  console.log(`IBKR read-only dashboard: ${config.publicUrl}`);
  console.log(config.accessMode === 'local' ? 'Local access: no dashboard password required (loopback only)' : 'Initial dashboard password: npm run show-login (local terminal only)');
  collector.start();
  performance.start();
  bot.start();
  discord.start();
});
async function shutdown() {
  server.close();
  await discord.stop();
  await performance.stop();
  await bot.stop();
  await collector.pause();
  server.closeAllConnections();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
