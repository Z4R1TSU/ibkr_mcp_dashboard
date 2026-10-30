import { config, intranetHttps } from './config.js';
import { startIntranetHttps } from './intranet-https.js';
import { Vault } from './vault.js';
import { IbkrClient, IbkrOAuth } from './ibkr.js';
import { Collector } from './collector.js';
import { TosMarket } from './tos-market.js';
import path from 'node:path';
import { createApp } from './app.js';
import { createBot } from './bot/index.js';
import { ResearchQuotes } from './research/quotes.js';
import { ForexHistory } from './forex.js';
import { DailyData } from './daily-data.js';
import { MarketIndicators } from './daily-indicators.js';
import { PerformanceSource } from './performance-source.js';
import { PresenceData } from './discord/data.js';
import { FrozenPresenceStore } from './discord/frozen.js';
import { createDiscord } from './discord/index.js';

const vault = new Vault();
if (config.accessMode === 'password') vault.ensureAdmin();
const client = new IbkrClient(new IbkrOAuth(vault));
const market = process.env.MARKET_DATA_PRIMARY === 'ibkr' ? undefined
  : new TosMarket(path.resolve(process.env.TOS_DATA_DIR || path.join(config.dataDir, 'thinkorswim')));
const collector = new Collector(client, config.dataDir, market);
const researchQuotes = new ResearchQuotes(client, () => collector.view().snapshot?.positions ?? []);
const forex = new ForexHistory(client);
const dailySnapshots = new FrozenPresenceStore(config.dataDir);
const performance = new PerformanceSource(client, config.dataDir, dailySnapshots);
const daily = new DailyData(client, performance, market);
const indicators = new MarketIndicators(config.dataDir);
const discord = createDiscord(config.dataDir, new PresenceData(() => collector.view(), () => performance.get(), () => daily.latestCompletedDate(), () => daily.previousTradingDate(), dailySnapshots, performance.peek(), () => performance.peek()), () => forex.capitalPreview(), { remote: config.discordTransport === 'remote' });
const bot = createBot({ researchQuote: researchQuotes.get, authStatus: broker => broker === 'ibkr' ? client.oauth.authStatus() : market?.authStatus() ?? 'disabled', view: () => collector.view(), refresh: () => collector.refresh(), forex: () => forex.get(), forexAnalysis: question => forex.analysis(question), dailyFacts: async () => dailySnapshots.applyFacts(await daily.get(collector.view())), dailySnapshot: facts => dailySnapshots.recordReport(facts), dailyIndicators: date => indicators.get(date) }, config);
const gateway = intranetHttps ? await startIntranetHttps(intranetHttps) : undefined;
const server = createApp(client, collector, config, () => bot.status(), bot.controls, discord.controls, performance).listen(config.port, config.host, () => {
  console.log(`IBKR read-only dashboard: ${config.publicUrl}`);
  console.log(config.accessMode === 'password' ? 'Initial dashboard password: npm run show-login (local terminal only)' : 'Password-free dashboard access: ' + config.accessMode);
  void client.oauth.prepare();
  collector.start();
  performance.start();
  bot.start();
  discord.start();
});
async function shutdown() {
  server.close();
  await gateway?.close();
  await discord.stop();
  await performance.stop();
  await bot.stop();
  await collector.pause();
  await client.oauth.settled();
  server.closeAllConnections();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
