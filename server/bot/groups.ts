import type { GroupRule } from '../../shared/groups.js';
import type { BotMessage } from './transport.js';
export type { GroupRule } from '../../shared/groups.js';

export function validateGroups(input: unknown): GroupRule[] {
  if (!Array.isArray(input) || input.length > 30) throw new Error('群配置应为列表，最多 30 个群');
  const seen = new Set<string>();
  return input.map(value => {
    if (!value || !/^oc_[a-zA-Z0-9]+$/.test(value.chatId) || seen.has(value.chatId)) throw new Error('群 ID 无效或重复');
    if (!['disabled', 'owner', 'members', 'allowlist'].includes(value.access)) throw new Error('群权限无效');
    if (!Array.isArray(value.members) || value.members.length > 300 || value.members.some((id: unknown) => typeof id !== 'string' || !/^ou_[a-zA-Z0-9]+$/.test(id))) throw new Error('成员 ID 无效');
    seen.add(value.chatId);
    return { chatId: value.chatId, name: String(value.name || value.chatId).slice(0, 100), access: value.access,
      members: [...new Set<string>(value.members)] };
  });
}

export function groupAllowed(message: BotMessage, rules: GroupRule[], owner: string, botId: string): boolean {
  if (!owner || !botId || !Array.isArray(message.mentions) || !message.mentions.some(m => m?.id === botId)) return false;
  const rule = rules.find(r => r.chatId === message.chat_id);
  if (!rule || rule.access === 'disabled') return false;
  return message.sender_id === owner || rule.access === 'members' || (rule.access === 'allowlist' && rule.members.includes(message.sender_id));
}

export function withoutBotMention(message: BotMessage, botId: string): string {
  let text = message.content;
  for (const mention of message.mentions ?? []) {
    if (mention.id !== botId) continue;
    if (mention.key) text = text.replaceAll(mention.key, '');
    if (mention.name) text = text.replaceAll('@' + mention.name, '');
  }
  return text.trim() || '帮助';
}
