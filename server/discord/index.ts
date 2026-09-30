import type { DiscordStatus } from '../../shared/discord.js';
import { DiscordSettingsStore, validateSettings } from './settings.js';
import { PresenceData } from './data.js';
import { DiscordBridge } from './bridge.js';

export function createDiscord(directory: string, data: PresenceData, capitalPreview = async (): Promise<unknown> => null) {
  const store = new DiscordSettingsStore(directory, process.env.DISCORD_START_DATE);
  const bridge = new DiscordBridge(() => store.get(), () => data.summary(store.get().startDate, undefined, store.get().capitalUsd).activity);
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const status = (): DiscordStatus => ({ settings: store.get(), connected: bridge.connected,
    lastSentAt: bridge.lastSentAt, error: store.error ?? bridge.error, summary: data.summary(store.get().startDate, undefined, store.get().capitalUsd) });
  async function refresh() { await data.refresh(); await bridge.sync(); }
  return {
    start() {
      if (running) return;
      running = true;
      bridge.start();
      if (store.get().enabled) void refresh();
      timer = setInterval(() => { if (store.get().enabled) void refresh(); }, 300000);
    },
    async stop() { running = false; clearInterval(timer); await bridge.stop(); },
    controls: {
      status,
      capitalPreview,
      async preview(startDate: unknown, capitalUsd: unknown = store.get().capitalUsd) {
        const draft = validateSettings({ enabled: false, applicationId: '', startDate, capitalUsd });
        await data.refresh();
        return data.summary(draft.startDate, undefined, draft.capitalUsd);
      },
      async update(input: unknown) {
        store.save(input);
        await bridge.reset();
        if (store.get().enabled) void refresh();
        return status();
      },
    },
  };
}
export type DiscordControls = ReturnType<typeof createDiscord>['controls'];
