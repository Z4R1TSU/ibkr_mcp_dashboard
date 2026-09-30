export interface GroupRule {
  chatId: string;
  name: string;
  access: 'disabled' | 'owner' | 'members' | 'allowlist';
  members: string[];
}
export interface GroupMember { id: string; name: string }
