import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BotConfig } from './config.js';
const run = promisify(execFile);

export class FeishuDirectory {
  constructor(private readonly config: BotConfig) {}
  private async read(args: string[]): Promise<any> {
    const env: NodeJS.ProcessEnv = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
    delete env.MODEL_API_KEY;
    try {
      const result = await run(this.config.cliPath, ['--profile', this.config.profile, ...args, '--as', 'bot', '--format', 'json'], { env, timeout: 30000, maxBuffer: 1024 * 1024 });
      const body = JSON.parse(result.stdout);
      if (!body.ok) throw new Error('Directory request failed');
      return body.data;
    } catch {
      throw new Error('飞书目录读取失败；读取群成员需要 im:chat.members:read 权限。');
    }
  }
  async chats() {
    const chats: { chatId: string; name: string }[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const data = await this.read(['im', '+chat-list', '--page-size', '100', ...(cursor ? ['--page-token', cursor] : [])]);
      for (const chat of data.chats ?? []) chats.push({ chatId: chat.chat_id, name: chat.name });
      if (!data.has_more) return chats;
      cursor = data.page_token;
    }
    throw new Error('群列表超过 500 项，请缩小机器人可用范围。');
  }
  async members(chatId: string) {
    if (!/^oc_[a-zA-Z0-9]+$/.test(chatId)) throw new Error('群 ID 无效');
    const data = await this.read(['im', '+chat-members-list', '--chat-id', chatId, '--member-types', 'user', '--page-all']);
    return { members: (data.users ?? []).map((member: any) => ({ id: member.member_id, name: member.name || member.member_id })),
      incomplete: Boolean(data.has_more || data.truncations?.length) };
  }
}
