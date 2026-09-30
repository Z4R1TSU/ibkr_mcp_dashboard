import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { GroupSettings } from './group-settings';
import type { GroupRule } from '../shared/groups';

interface IntegrationStatus {
  enabled: boolean;
  paired?: boolean;
  pairing?: { command: string; expiresAt: string } | null;
  transport?: { connected: boolean; error: string | null; reactionError?: string | null };
  modelConfigured?: boolean;
  modelName?: string | null;
  dailyTime?: string | null;
  alerts?: boolean;
  timeZone?: string;
  groups?: GroupRule[];
  memoryEnabled?: boolean;
  memoryTurns?: number;
}

export function IntegrationsPanel({ close }: { close: () => void }) {
  const [value, setValue] = useState<IntegrationStatus | null>(null);
  const [error, setError] = useState('');
  const [report, setReport] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  async function previewReport() {
    setReportBusy(true);
    try {
      const response = await fetch('/api/integrations/report', { credentials: 'same-origin' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '日报生成失败');
      setReport(body.text); setError('');
    } catch (problem) { setError((problem as Error).message); }
    finally { setReportBusy(false); }
  }
  useEffect(() => {
    let active = true;
    async function read() {
      try {
        const response = await fetch('/api/integrations', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Status unavailable');
        const data = await response.json();
        if (active) { setValue(data); setError(''); }
      } catch { if (active) setError('无法读取连接状态，请确认服务仍在运行。'); }
    }
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return <div className="modal-backdrop" onClick={close}><section className="modal panel integrations-modal" role="dialog" aria-modal="true" aria-label="飞书与模型" onClick={e => e.stopPropagation()}>
    <div className="panel-heading"><h2>飞书与模型</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={18} /></button></div>
    {error && <p role="alert">{error}</p>}
    {!value ? <p>正在读取连接状态…</p> : <>
      <p>飞书：{!value.enabled ? '未启用' : value.transport?.connected ? '长连接已就绪' : '连接中'}</p>
      {value.transport?.error && <p className="amber">{value.transport.error}</p>}
      {value.transport?.reactionError && <p className="amber">{value.transport.reactionError}</p>}
      <p>账户绑定：{value.paired ? '已绑定账户管理员' : '待绑定'}</p>
      {value.pairing && <><p>将下面这条指令私聊发送给“持仓助手”：</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'all' }}>{value.pairing.command}</pre><p className="muted">有效期至 {new Date(value.pairing.expiresAt).toLocaleTimeString()}，绑定后失效。</p></>}
      <p>日报：{value.dailyTime ?? '关闭'} {value.timeZone}</p><p>状态提醒：{value.alerts ? '开启' : '关闭'}</p>
      <p>日报发送至：账户管理员私聊</p>
      <button type="button" className="button secondary" disabled={reportBusy} onClick={() => void previewReport()}>{reportBusy ? '正在生成日报…' : '预览上一交易日报'}</button>
      {report && <details open><summary>日报预览</summary><pre className="daily-preview">{report}</pre></details>}
      <p>模型：{value.modelConfigured ? value.modelName ?? '已配置' : '入口已预留，尚未配置'}</p>
      <p>多轮记忆：{value.memoryEnabled ? '已开启，最多 ' + value.memoryTurns + ' 轮；私聊与各群隔离' : '未开启'}</p>
      <p className="muted">模型启用后会使用账户快照回答问题。接口地址、API Key 和模型名由服务端配置。</p>
      {value.enabled && value.paired && <GroupSettings initial={value.groups ?? []} />}
    </>}
  </section></div>;
}
