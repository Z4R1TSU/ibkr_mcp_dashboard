import { readBotConfig, readModelConfig } from './config.js';
import { BotStore } from './store.js';
import { CliTransport } from './transport.js';
import { CompatibleModel } from './model.js';
import { PortfolioBot, type AccountSource } from './service.js';
import { FeishuDirectory } from './directory.js';
import type { IntegrationControls } from '../app.js';
import { ConversationMemory } from './memory.js';
import { PythonResearchRunner, researchConfig } from '../research/runner.js';
import { ResearchJobs } from '../research/jobs.js';

export function createBot(source: AccountSource, app: { publicUrl: string; dataDir: string }) {
  const config = readBotConfig(process.env, app);
  const modelConfig = readModelConfig(process.env);
  const model = new CompatibleModel(modelConfig);
  if (!config.enabled) return {
    start: () => undefined,
    stop: async () => undefined,
    status: () => ({ enabled: false, modelConfigured: model.configured }),
    controls: undefined as IntegrationControls | undefined,
  };
  const transport = new CliTransport(config);
  const memory = process.env.MEMORY_ENABLED === 'true' ? new ConversationMemory(config.dataDir) : undefined;
  const research = new ResearchJobs(config.dataDir, new PythonResearchRunner(researchConfig(process.env), modelConfig));
  const bot = new PortfolioBot(config, new BotStore(config.dataDir, config.profile, config.ownerOpenId), source, transport, model, memory, research);
  const directory = new FeishuDirectory(config);
  return {
    start: () => { transport.start(message => { void bot.receive(message); }); bot.start(); },
    stop: async () => { await transport.stop(); await bot.stop(); },
    status: () => ({ ...bot.status(), transport: { ...transport.status } }),
    controls: {
      groups: (input: unknown) => bot.updateGroups(input),
      chats: () => directory.chats(),
      members: (chatId: string) => directory.members(chatId),
      daily: (input: unknown) => bot.setDaily(input),
      report: () => bot.previewDaily(),
    } satisfies IntegrationControls,
  };
}
