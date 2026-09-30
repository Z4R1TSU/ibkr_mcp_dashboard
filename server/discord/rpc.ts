import { Client } from '@xhayper/discord-rpc';
import type { PresenceActivity } from '../../shared/discord.js';

export interface PresenceConnection {
  readonly connected: boolean;
  connect(): Promise<void>;
  send(activity: PresenceActivity | null): Promise<void>;
  close(): Promise<void>;
}

export function createPresenceConnection(applicationId: string): PresenceConnection {
  const client = new Client({ clientId: applicationId, transport: { type: 'ipc' } });
  return {
    get connected() { return client.isConnected; },
    connect: () => client.login(),
    send: async activity => {
      if (!client.user) throw new Error('Discord 尚未就绪');
      if (activity) await client.user.setActivity({ name: '我的投资账户', ...activity, type: 3, statusDisplayType: 2 });
      else await client.user.clearActivity();
    },
    close: () => client.destroy(),
  };
}
