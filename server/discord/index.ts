import type { DiscordStatus } from '../../shared/discord.js';
import { DiscordSettingsStore, validateSettings } from './settings.js';
import { PresenceData } from './data.js';
import { DiscordBridge } from './bridge.js';
import { RemoteDiscord } from './remote.js';
import fs from 'node:fs';
import path from 'node:path';

export function createDiscord(directory: string, data: PresenceData, capitalPreview = async (): Promise<unknown> => null, options: { remote?: boolean } = {}) {
  const store = new DiscordSettingsStore(directory, process.env.DISCORD_START_DATE);
  const bridge = new DiscordBridge(() => store.get(), () => data.summary(store.get().startDate, undefined, store.get().capitalUsd).activity);
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const remote = options.remote ? new RemoteDiscord(directory) : undefined;
  const macPackage = () => {
    const file = path.join(directory, 'discord-mac.tar.gz');
    return remote && fs.existsSync(file) ? file : null;
  };
  const status = (): DiscordStatus => {
    const current = remote ? remote.status() : bridge;
    return { settings: store.get(), transport: remote ? 'remote' : 'local', macDownloadAvailable: Boolean(macPackage()),
      connected: store.get().enabled && current.connected, lastSentAt: current.lastSentAt,
      error: store.error ?? (store.get().enabled ? current.error : null),
      summary: data.summary(store.get().startDate, undefined, store.get().capitalUsd) };
  };
  async function refresh() { await data.refresh(); await bridge.sync(); }
  return {
    start() {
      if (running) return;
      running = true;
      if (!remote) bridge.start();
      if (store.get().enabled) void refresh();
      timer = setInterval(() => { if (store.get().enabled) void refresh(); }, 300000);
    },
    async stop() { running = false; clearInterval(timer); await bridge.stop(); },
    controls: {
      status,
      capitalPreview,
      macPackage,
      remote: remote ? {
        authorized: (value: unknown) => remote.authorized(value),
        payload: () => ({ settings: { enabled: store.get().enabled, applicationId: store.get().applicationId }, summary: status().summary }),
        report: (value: unknown) => remote.report(value),
      } : undefined,
      async preview(startDate: unknown, capitalUsd: unknown = store.get().capitalUsd) {
        const draft = validateSettings({ enabled: false, applicationId: '', startDate, capitalUsd });
        await data.refresh();
        return data.summary(draft.startDate, undefined, draft.capitalUsd);
      },
      async update(input: unknown) {
        store.save(input);
        if (remote) remote.reset();
        else await bridge.reset();
        if (store.get().enabled) void refresh();
        return status();
      },
    },
  };
}
export type DiscordControls = ReturnType<typeof createDiscord>['controls'];
