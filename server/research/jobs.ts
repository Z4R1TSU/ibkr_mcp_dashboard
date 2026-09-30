import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ResearchInput, ResearchResult, ResearchRunner } from './runner.js';

type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
interface Job {
  id: string; ticker: string; date: string; requester: string; status: JobStatus;
  stage: string; calls: number; startedAt: string; finishedAt: string | null; error: string | null; notification: string | null;
}
interface ActiveJob { scope: string; record: Job; controller: AbortController; pending?: Promise<void> }

export const RESEARCH_HELP = [
  'TradingAgents · 只读研究',
  '/research AAPL：研究指定股票；四类分析师、多空讨论与风险讨论均复用持仓助手当前模型',
  '/research status：查看当前聊天的最近一次研究进度',
  '/research report：获取当前聊天最近完成的完整报告',
  '/research cancel：停止当前研究（发起人或账户管理员）',
  '这是固定命令，不需要使用“深度研究”关键词。群聊仍需 @ 机器人且具备查询权限。',
  '研究在后台运行；同一时间只执行一个研究任务。仅手动触发，绝不下单。',
].join('\n');

export type ResearchCommand = { kind: 'help' | 'status' | 'report' | 'cancel' | 'invalid' } | { kind: 'run'; ticker: string };
export function parseResearchCommand(text: string): ResearchCommand | null {
  if (!/^\/research(?:\s|$)/i.test(text.trim())) return null;
  const args = text.trim().split(/\s+/).slice(1);
  if (!args.length || args.length === 1 && args[0].toLowerCase() === 'help') return { kind: 'help' };
  if (args.length !== 1) return { kind: 'invalid' };
  const action = args[0].toLowerCase();
  if (action === 'status' || action === 'report' || action === 'cancel') return { kind: action };
  const ticker = args[0].replace(/^\$/, '').toUpperCase();
  return /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) && !ticker.includes('..') ? { kind: 'run', ticker } : { kind: 'invalid' };
}

export class ResearchJobs {
  private active?: ActiveJob;
  private stopped = false;
  constructor(private readonly directory: string, private readonly runner: ResearchRunner) {}
  status() { return { available: !this.runner.unavailable(), reason: this.runner.unavailable(), running: Boolean(this.active), model: this.runner.modelName }; }
  private scopeDir(scope: string): string { return path.join(this.directory, 'research', createHash('sha256').update(scope).digest('hex')); }
  private save(scope: string, record: Job): void {
    const directory = this.scopeDir(scope);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'latest.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  private read(scope: string): Job | null {
    if (this.active?.scope === scope) return this.active.record;
    const file = path.join(this.scopeDir(scope), 'latest.json');
    if (!fs.existsSync(file)) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Job;
    if (!/^[a-f0-9-]{36}$/.test(record.id)) throw new Error('Invalid saved research task');
    if (record.status === 'running' || record.status === 'queued') {
      record.status = 'interrupted'; record.error = '服务重启中断了研究；不会自动重跑或额外调用模型。';
      record.finishedAt = new Date().toISOString(); this.save(scope, record);
    }
    return record;
  }
  describe(scope: string): string {
    const job = this.read(scope);
    if (!job) return '当前聊天尚无研究任务。发送 /research AAPL 开始只读研究。';
    const labels: Record<JobStatus, string> = { queued: '等待启动', running: '研究中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
    return [job.ticker + ' · ' + labels[job.status], '任务：' + job.id.slice(0, 8), '开始：' + job.startedAt,
      '阶段：' + job.stage, '模型调用：' + job.calls, job.error, job.notification,
      job.status === 'completed' ? '发送 /research report 获取完整报告。' : '', '仅研究，未下单。'].filter(Boolean).join('\n');
  }
  report(scope: string): string {
    const job = this.read(scope);
    if (!job || job.status !== 'completed') return this.describe(scope);
    const result = JSON.parse(fs.readFileSync(path.join(this.scopeDir(scope), job.id, 'result.json'), 'utf8')) as ResearchResult;
    return result.report;
  }
  cancel(scope: string, sender: string, owner: string): string {
    const active = this.active;
    if (!active || active.scope !== scope || !['queued', 'running'].includes(active.record.status)) return '当前聊天没有正在运行的研究。';
    if (sender !== active.record.requester && sender !== owner) return '仅研究发起人或账户管理员可以停止本次研究。';
    active.controller.abort();
    active.record.status = 'cancelled'; active.record.stage = '停止研究进程';
    this.save(scope, active.record);
    return '已请求停止研究；不会下单。';
  }
  prepare(scope: string, requester: string, input: Omit<ResearchInput, 'directory'>) {
    if (this.stopped) throw new Error('服务正在停止，暂不接收新研究。');
    const unavailable = this.runner.unavailable();
    if (unavailable) throw new Error(unavailable);
    if (this.active) throw new Error('已有研究任务正在运行，请稍后再试；普通持仓查询不受影响。');
    const record: Job = { id: randomUUID(), ticker: input.ticker, date: input.date, requester, status: 'queued', stage: '等待启动', calls: 0,
      startedAt: new Date().toISOString(), finishedAt: null, error: null, notification: null };
    const active: ActiveJob = { scope, record, controller: new AbortController() };
    this.save(scope, record);
    this.active = active;
    return {
      acknowledgement: ['已创建 ' + input.ticker + ' 的 TradingAgents 只读研究。', '任务：' + record.id.slice(0, 8), '模型：' + this.runner.modelName,
        '研究可能耗时数分钟；结果会返回本聊天，普通持仓查询不受影响。',
        '发送 /research status 查看进度，/research cancel 停止。', '仅研究，绝不下单。'].join('\n'),
      discard: () => { if (this.active !== active || active.pending) return; record.status = 'cancelled'; record.finishedAt = new Date().toISOString(); this.save(scope, record); this.active = undefined; },
      start: (deliver: (summary: string, key: string) => Promise<void>, allowed: () => boolean) => {
        if (this.active !== active || active.pending) return;
        active.pending = this.execute(active, input, deliver, allowed).catch(() => {
          record.status = 'failed'; record.error = '研究任务保存失败，未确认完整结果；没有下单。';
          try { this.save(scope, record); } catch {}
          if (this.active === active) this.active = undefined;
        });
      },
    };
  }
  private async execute(active: ActiveJob, input: Omit<ResearchInput, 'directory'>, deliver: (summary: string, key: string) => Promise<void>, allowed: () => boolean): Promise<void> {
    const { scope, record, controller } = active;
    const directory = path.join(this.scopeDir(scope), record.id);
    let summary = '';
    try {
      record.status = 'running'; record.stage = '启动原版工作流'; this.save(scope, record);
      const result = await this.runner.run({ ...input, directory }, controller.signal, (stage, calls) => {
        record.stage = stage; if (calls !== undefined) record.calls = calls; this.save(scope, record);
      });
      if (controller.signal.aborted) throw new Error('研究已取消。');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result), { mode: 0o600 });
      record.status = 'completed'; record.stage = '报告已保存';
      summary = result.summary + '\n\n发送 /research report 获取全部分析章节。';
    } catch (error) {
      record.status = controller.signal.aborted ? 'cancelled' : 'failed';
      record.error = error instanceof Error ? error.message : '研究失败，未生成完整报告。';
      record.stage = '研究已停止';
      summary = record.ticker + '：' + record.error + '\n没有下单；发送 /research status 查看状态。';
    }
    record.finishedAt = new Date().toISOString();
    try {
      this.save(scope, record);
      if (!this.stopped && allowed()) {
        try { await deliver(summary, 'research-result:' + record.id); }
        catch { record.notification = '报告通知发送失败，可发送 /research report 重新获取。'; }
      } else record.notification = '权限已变更或服务停止，未推送结果。';
      this.save(scope, record);
    } finally { if (this.active === active) this.active = undefined; }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    if (active.pending) await active.pending;
    else { active.record.status = 'cancelled'; this.save(active.scope, active.record); this.active = undefined; }
  }
}
