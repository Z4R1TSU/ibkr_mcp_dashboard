import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGroups, groupAllowed, withoutBotMention } from '../server/bot/groups.js';
import type { BotMessage } from '../server/bot/transport.js';

const event: BotMessage = { sender_id: 'ou_owner', sender_type: 'user', chat_type: 'group',
  chat_id: 'oc_group', message_id: 'om_msg', message_type: 'text', create_time: String(Date.now()),
  content: '@持仓助手 摘要', mentions: [{ id: 'ou_bot', name: '持仓助手', key: '@_user_1' }] };
test('owner-only group checks the real mention and owner identity', () => {
  const rules = validateGroups([{ chatId: 'oc_group', name: 'group', access: 'owner', members: [] }]);
  assert.equal(groupAllowed(event, rules, 'ou_owner', 'ou_bot'), true);
  assert.equal(groupAllowed({ ...event, sender_id: 'ou_guest' }, rules, 'ou_owner', 'ou_bot'), false);
  assert.equal(groupAllowed({ ...event, mentions: [] }, rules, 'ou_owner', 'ou_bot'), false);
  assert.equal(groupAllowed(event, rules, '', 'ou_bot'), false);
  assert.equal(withoutBotMention(event, 'ou_bot'), '摘要');
});
test('malformed or duplicate group rules cannot be persisted', () => {
  assert.throws(() => validateGroups([{ chatId: '--unsafe', access: 'members', members: [] }]));
  assert.throws(() => validateGroups([{ chatId: 'oc_group', access: 'members', members: 'ou_user' }]));
  const valid = { chatId: 'oc_group', access: 'members', members: [] };
  assert.throws(() => validateGroups([valid, valid]));
  assert.throws(() => validateGroups([{ ...valid, access: 'anything' }]));
});
