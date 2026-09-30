import { useEffect, useState } from 'react';
import type { GroupRule, GroupMember } from '../shared/groups';

async function read<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body as T;
}

function MemberPicker({ chatId, selected, change }: { chatId: string; selected: string[]; change: (value: string[]) => void }) {
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [notice, setNotice] = useState('正在读取群成员…');
  async function load() {
    try {
      const data = await read<{ members: GroupMember[]; incomplete: boolean }>('/api/integrations/members/' + chatId);
      setMembers(data.members); setNotice(data.incomplete ? '成员列表不完整，可补充 open_id。' : '');
    } catch (error) { setNotice((error as Error).message); }
  }
  useEffect(() => { void load(); }, [chatId]);
  return <div>
    {notice && <p className="muted">{notice}</p>}
    <button className="button secondary" type="button" onClick={() => void load()}>重新读取成员</button>
    <div className="member-options">{members.map(member => <label key={member.id}>
      <input type="checkbox" checked={selected.includes(member.id)} onChange={event => change(event.target.checked ? [...selected, member.id] : selected.filter(id => id !== member.id))} />{member.name}
    </label>)}</div>
    <label>允许的成员 open_id（每行一个）<textarea value={selected.join('\n')} onChange={event => change(event.target.value.split(/[\s,，]+/).filter(Boolean))} rows={3} /></label>
  </div>;
}

export function GroupSettings({ initial }: { initial: GroupRule[] }) {
  const [rules, setRules] = useState(initial);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  async function loadChats() {
    setBusy(true);
    try {
      const data = await read<{ chats: { chatId: string; name: string }[] }>('/api/integrations/chats');
      setRules(current => {
        const merged = new Map(current.map(rule => [rule.chatId, rule]));
        for (const chat of data.chats) {
          const old = merged.get(chat.chatId);
          merged.set(chat.chatId, old ? { ...old, name: chat.name } : { ...chat, access: 'disabled', members: [] });
        }
        return [...merged.values()];
      });
      setNotice('');
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void loadChats(); }, []);
  const update = (chatId: string, change: Partial<GroupRule>) => setRules(old => old.map(rule => rule.chatId === chatId ? { ...rule, ...change } : rule));
  async function save() {
    setBusy(true);
    try {
      const session = await read<{ authenticated: boolean; csrf: string }>('/api/session');
      if (!session.authenticated) throw new Error('请先登录看板');
      await read('/api/integrations/groups', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ groups: rules }) });
      setNotice('群聊权限已保存，立即生效。');
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="group-settings">
    <h3>群聊权限</h3><p className="muted">群内回复对全群可见。只响应 @；订阅、偏好与授权仍由你在私聊管理。</p>
    <button type="button" className="button secondary" disabled={busy} onClick={() => void loadChats()}>刷新已加入的群</button>
    {rules.map(rule => <div className="group-rule" key={rule.chatId}>
      <strong>{rule.name}</strong><small>{rule.chatId}</small>
      <select aria-label={rule.name + '查询权限'} value={rule.access} onChange={event => update(rule.chatId, { access: event.target.value as GroupRule['access'] })}>
        <option value="disabled">关闭群聊</option><option value="owner">仅我可用</option>
        <option value="members">全群成员可用</option><option value="allowlist">指定成员可用</option>
      </select>
      {rule.access === 'allowlist' && <MemberPicker chatId={rule.chatId} selected={rule.members} change={members => update(rule.chatId, { members })} />}
    </div>)}
    <button type="button" className="button primary" disabled={busy} onClick={() => void save()}>保存群聊权限</button>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
