import type { DashboardState } from '../../shared/types.js';
import type { BrokerAuthState, BrokerId } from '../../shared/broker-auth.js';
import { LoginAlerts } from './login-alerts.js';
import type { BotConfig } from './config.js';
import type { BotMessage, BotTransport } from './transport.js';
import type { AccountModel } from './model.js';
import { BotStore } from './store.js';
import { accountSummary, freshness, dataWarning, HELP, holdings, risks, IB_LOGIN_HINT, ibkrLoginInstructions } from './answers.js';
import { parseDailySchedule, scheduledReportDate } from './schedule.js';
import { groupAllowed, withoutBotMention, validateGroups } from './groups.js';
import { ConversationMemory } from './memory.js';
import type { ModelMessage } from './model-protocol.js';
import { createHash } from 'node:crypto';
import { DailyReports, dailyFactsText } from '../daily-report.js';
import type { DailyFacts } from '../daily-data.js';
import type { DailyIndicators } from '../daily-indicators.js';
import { dashboardCard, isDashboardCommand } from './dashboard-card.js';
import { resolveSlashCommand } from './slash-commands.js';
import { ResearchJobs, parseResearchCommand, RESEARCH_HELP, type ResearchCommand } from '../research/jobs.js';
import { researchAccount, researchDate } from '../research/runner.js';
import type { ResearchQuoteSource } from '../research/quotes.js';

interface ChatContext { inGroup: boolean; history: ModelMessage[]; speaker: string }

export interface AccountSource {
  researchQuote?: ResearchQuoteSource;
  authStatus?(broker: BrokerId): BrokerAuthState;
  view(): DashboardState;
  refresh(): Promise<void>;
  forex?(): Promise<string>;
  forexAnalysis?(question: string): Promise<string>;
  dailyFacts?(): Promise<DailyFacts>;
  dailySnapshot?(facts: DailyFacts): DailyFacts;
  dailyIndicators?(date: string): Promise<DailyIndicators>;
}

export class PortfolioBot {
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private tickPending = false;
  private lastRefresh = 0;
  private readonly reports?: DailyReports;
  readonly loginAlerts: LoginAlerts;
  readonly activity = { lastMessageAt: null as string | null, lastReplyAt: null as string | null, lastPushAt: null as string | null, error: null as string | null };
  constructor(
    readonly config: BotConfig, readonly store: BotStore,
    private readonly source: AccountSource, private readonly transport: BotTransport,
    private readonly model: AccountModel,
    private readonly memory?: ConversationMemory,
    private readonly research?: ResearchJobs,
  ) {
    this.loginAlerts = new LoginAlerts(config, store, broker => source.authStatus?.(broker) ?? 'unknown',
      transport, at => { this.activity.lastPushAt = at; });
    if (source.dailyFacts) this.reports = new DailyReports(config.dataDir, model, () => source.dailyFacts!(), source.dailySnapshot, source.dailyIndicators);
  }

  previewDaily(): Promise<string> {
    const result = this.queue.then(() => this.generateDaily());
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private generateDaily(expectedDate?: string): Promise<string> {
    if (!this.reports) return Promise.reject(new Error('日报数据源尚未配置'));
    return this.reports.generate(this.store.state.preferences, expectedDate);
  }

  status() {
    return { enabled: true, paired: Boolean(this.store.state.ownerOpenId), pairing: this.store.pairingInfo(),
      loginAlerts: this.loginAlerts.status(),
      groups: this.store.state.groups ?? [],
      memoryEnabled: Boolean(this.memory), memoryTurns: this.memory?.maxTurns ?? 0,
      contextBudgetTokens: this.model.contextTokens ?? null,
      dailyTime: this.store.state.dailyTime, alerts: this.store.state.alerts, timeZone: this.store.state.dailyTimeZone ?? this.config.timeZone,
      modelConfigured: this.model.configured, modelName: this.model.configured ? this.model.name : null, modelDiagnostics: this.model.diagnostics ?? null,
      research: this.research?.status() ?? null, ...this.activity };
  }

  updateGroups(groups: unknown): void {
    if (!this.config.botOpenId) throw new Error('请先配置机器人的 open_id');
    this.store.state.groups = validateGroups(groups);
    this.store.save();
  }

  setDaily(input: unknown): void {
    if (typeof input !== 'string') throw new Error('请提供日报订阅时间');
    const daily = parseDailySchedule(input, this.config.timeZone);
    if (daily.kind !== 'valid') throw new Error('日报时间无效');
    this.store.state.dailyTime = daily.time;
    this.store.state.dailyTimeZone = daily.timeZone;
    this.store.save();
  }

  start(): void {
    this.loginAlerts.start();
    this.timer = setInterval(() => {
      if (this.tickPending) return;
      this.tickPending = true;
      this.queue = this.queue.then(() => this.tick()).catch(() => { this.activity.error = '主动推送失败，稍后重试'; })
        .finally(() => { this.tickPending = false; });
    }, 30000);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.loginAlerts.stop();
    await this.research?.stop();
    await this.queue;
  }

  receive(message: BotMessage): Promise<void> {
    if (!message || message.sender_type !== 'user' || !['p2p', 'group'].includes(message.chat_type)) return Promise.resolve();
    if (!/^ou_[a-zA-Z0-9]+$/.test(message.sender_id) || !/^om_[a-zA-Z0-9]+$/.test(message.message_id)) return Promise.resolve();
    if (typeof message.content !== 'string' || message.content.length > 32000 || message.message_type !== 'text') return Promise.resolve();
    const age = Date.now() - Number(message.create_time);
    if (!Number.isFinite(age) || age < -60000 || age > 5 * 60000) return Promise.resolve();
    const owner = this.store.state.ownerOpenId;
    if (message.chat_type === 'group') {
      if (!groupAllowed(message, this.store.state.groups ?? [], owner, this.config.botOpenId ?? '')) return Promise.resolve();
      message = { ...message, content: withoutBotMention(message, this.config.botOpenId!) };
    } else if (owner && owner !== message.sender_id) return Promise.resolve();
    const key = 'message:' + message.message_id;
    if (this.pending.has(key) || this.store.delivered(key) || this.pending.size >= 8) return Promise.resolve();
    this.pending.add(key);
    // Acknowledge immediately, including messages waiting behind a slow answer.
    const receipt = owner ? this.acknowledge(message.message_id) : Promise.resolve();
    this.queue = this.queue.then(() => this.handle(message, key, receipt))
      .catch(() => { this.activity.error = '回复失败，请稍后重试'; })
      .finally(async () => { await receipt; this.pending.delete(key); });
    return this.queue;
  }

  private async acknowledge(messageId: string): Promise<void> {
    try { await this.transport.acknowledge?.(messageId); }
    catch { /* Receipt feedback must never prevent an answer. */ }
  }

  private async handle(message: BotMessage, key: string, receipt: Promise<void>): Promise<void> {
    if (!this.store.state.ownerOpenId) {
      const match = /^绑定\s+([a-zA-Z0-9_-]+)$/.exec(message.content.trim());
      if (!match || !this.store.bind(message.sender_id, match[1])) return;
      await this.acknowledge(message.message_id);
      await this.transport.send(message.sender_id, '绑定成功。你可以私聊管理账户，群聊按看板设置的权限查询。\n日报与提醒默认关闭，可发送“订阅日报北京时间 11:00 发送”或“开启提醒”。\n\n' + HELP, key);
    } else {
      const inGroup = message.chat_type === 'group';
      if (inGroup && !groupAllowed(message, this.store.state.groups ?? [], this.store.state.ownerOpenId, this.config.botOpenId ?? '')) return;
      if (!inGroup && message.sender_id !== this.store.state.ownerOpenId) return;
      this.activity.lastMessageAt = new Date().toISOString();
      const scope = inGroup ? 'group:' + message.chat_id : 'dm:' + message.sender_id;
      const originalText = message.content.trim();
      const slash = resolveSlashCommand(originalText);
      if (slash && 'error' in slash) {
        await receipt;
        await this.transport.send(inGroup ? message.chat_id! : message.sender_id, slash.error, key);
        this.store.markDelivered(key);
        this.activity.lastReplyAt = new Date().toISOString();
        this.activity.error = null;
        return;
      }
      const text = slash?.text ?? originalText;
      const research = parseResearchCommand(text);
      if (research) {
        await receipt;
        await this.handleResearch(research, message, scope, key);
        this.store.markDelivered(key);
        this.activity.lastReplyAt = new Date().toISOString();
        this.activity.error = null;
        return;
      }
      const clear = ['清空上下文', '清空对话', '重新开始对话'].includes(text);
      const dashboard = isDashboardCommand(text) ? this.source.view() : null;
      const speaker = inGroup ? '群成员-' + createHash('sha256').update(message.sender_id).digest('hex').slice(0, 8) : '';
      let answer: string;
      if (clear) {
        if (inGroup && message.sender_id !== this.store.state.ownerOpenId) answer = '仅账户管理员可以清空本群上下文。';
        else if (!this.memory) answer = '当前未开启多轮记忆。';
        else { this.memory.clear(scope); answer = '已清空当前对话上下文，其他对话和已设置的偏好不受影响。'; }
      } else if (dashboard) {
        answer = accountSummary(dashboard) + '\n\n' + freshness(dashboard);
      } else {
        answer = await this.answer(text, { inGroup, history: this.memory?.read(scope) ?? [], speaker });
      }
      await receipt;
      const recipient = inGroup ? message.chat_id! : message.sender_id;
      if (dashboard && this.transport.sendCard) {
        try { await this.transport.sendCard(recipient, dashboardCard(dashboard, this.config.publicUrl, this.config.timeZone), key); }
        catch { await this.transport.send(recipient, '看板卡片暂时发送失败，先展示账户摘要。\n\n' + answer, key); }
      } else await this.transport.send(recipient, answer, key);
      if (!clear) this.memory?.append(scope, speaker ? '[' + speaker + '] ' + originalText : originalText, answer);
    }
    this.store.markDelivered(key);
    this.activity.lastReplyAt = new Date().toISOString();
    this.activity.error = null;
  }

  private async handleResearch(command: ResearchCommand, message: BotMessage, scope: string, key: string): Promise<void> {
    const inGroup = message.chat_type === 'group';
    const recipient = inGroup ? message.chat_id! : message.sender_id;
    const send = (text: string) => this.transport.send(recipient, text, key);
    if (command.kind === 'help' || command.kind === 'invalid') {
      await send((command.kind === 'invalid' ? '命令格式：/research 股票代码，例如 /research AAPL。\n\n' : '') + RESEARCH_HELP); return;
    }
    if (!this.research) { await send('TradingAgents 研究尚未启用。'); return; }
    if (command.kind === 'status') { await send(this.research.describe(scope)); return; }
    if (command.kind === 'report') { await send(this.research.report(scope)); return; }
    if (command.kind === 'cancel') { await send(this.research.cancel(scope, message.sender_id, this.store.state.ownerOpenId)); return; }
    if (command.kind !== 'run') return;
    let task: ReturnType<ResearchJobs['prepare']>;
    // Read positions when the job actually starts, so the report reflects
    // trades made since the last background read. A failed or slow read keeps
    // the cached snapshot, whose own fetchedAt/stale fields go into the report.
    const account = async () => {
      await Promise.race([this.source.refresh().catch(() => {}), new Promise(resolve => setTimeout(resolve, 30000).unref())]);
      return researchAccount(this.source.view());
    };
    try {
      task = this.research.prepare(scope, message.sender_id, { ticker: command.ticker, date: researchDate(), account });
    } catch (error) { await send(error instanceof Error ? error.message : '暂时无法启动研究。'); return; }
    try { await send(task.acknowledgement); }
    catch (error) { task.discard(); throw error; }
    task.start(async (summary, resultKey) => {
      await this.transport.send(recipient, summary, resultKey);
      this.memory?.append(scope, '/research ' + command.ticker, summary);
      this.activity.lastReplyAt = new Date().toISOString();
    }, () => inGroup ? groupAllowed(message, this.store.state.groups ?? [], this.store.state.ownerOpenId, this.config.botOpenId ?? '')
      : message.sender_id === this.store.state.ownerOpenId);
  }

  private async answer(text: string, context: ChatContext): Promise<string> {
    const { inGroup } = context;
    const command = text.replace(/\s+/g, '').toLowerCase();
    const management = parseDailySchedule(text, this.config.timeZone).kind !== 'none' || /^(取消日报|开启提醒|关闭提醒|查看偏好|清除偏好|偏好|绑定|授权|登录|连接ib)/i.test(command);
    if (inGroup && management) return '订阅、偏好和授权仅允许账户持有人在私聊中管理。群内可查询摘要、持仓、风险、换汇，或直接提问。';
    const state = this.source.view();
    const facts = (content: string) => content + dataWarning(state);
    if (['帮助', 'help', '/help', '菜单', '测试'].includes(command)) return HELP;
    if (['日报', '查看日报', '生成日报', '推送一次'].includes(command)) {
      if (inGroup) return '日报仅向账户管理员私聊发送，请在私聊中查看。';
      try { return await this.generateDaily(); }
      catch { return '日报生成暂未完成，上一交易日数据可能尚未齐全，请稍后重试。'; }
    }
    if (['摘要', '账户', '账户摘要', 'summary'].includes(command)) return facts(accountSummary(state));
    if (['持仓', 'positions', '我的持仓'].includes(command)) return facts(holdings(state));
    if (['风险', '到期', '期权', 'risk'].includes(command)) return facts(risks(state));
    if (['换汇', '换汇记录', '今年换汇', '今年换汇记录'].includes(command)) {
      if (!this.source.forex) return '换汇记录尚未接入。';
      const report = await this.source.forex();
      return report + (!this.source.view().status.connected ? '\n\n' + IB_LOGIN_HINT : '');
    }
    if (['连接ib', '授权', '登录'].includes(command)) return ibkrLoginInstructions(this.config.publicUrl);
    if (command.startsWith('绑定')) return '此机器人已绑定，不能通过聊天更换账户持有人。';
    return this.answerSettings(text, command, state, context);
  }

  private async answerSettings(text: string, command: string, state: DashboardState, context: ChatContext): Promise<string> {
    if (['状态', 'status', '模型状态'].includes(command)) return [
      '飞书消息链路正常', this.model.configured ? '模型：' + this.model.name : '模型：待配置',
      '日报：' + (this.store.state.dailyTime ?? '关闭') + '（' + (this.store.state.dailyTimeZone ?? this.config.timeZone) + '）',
      '登录失效提醒：自动开启（IBKR / 嘉信，每次失效一次）',
      '数据过期／恢复提醒：' + (this.store.state.alerts ? '开启' : '关闭'), freshness(state),
    ].join('\n');
    if (command === '刷新') {
      if (Date.now() - this.lastRefresh < 30000) return '请至少间隔 30 秒再刷新。';
      this.lastRefresh = Date.now();
      await this.source.refresh();
      const updated = this.source.view();
      return accountSummary(updated) + dataWarning(updated);
    }
    const daily = parseDailySchedule(text, this.config.timeZone);
    if (daily.kind === 'valid') {
      this.setDaily(text);
      return '已订阅账户日报，发送时间 ' + daily.time + '，时区 ' + daily.timeZone + '；仅在有新完成的美股交易日时推送，同一交易日只推送一次。发送“取消日报”可停止。';
    }
    if (daily.kind === 'invalid') return '没有识别到唯一有效的时间。可以说“订阅日报北京时间 11:00 发送”或“每天上午11点给我发日报”。';
    if (command === '取消日报') {
      this.store.state.dailyTime = null; this.store.save();
      return '已取消日报。';
    }
    if (['开启提醒', '关闭提醒'].includes(command)) {
      this.store.state.alerts = command === '开启提醒';
      this.store.state.lastHealth = null; this.store.save();
      return (this.store.state.alerts ? '已开启账户数据过期／恢复提醒。' : '已关闭账户数据过期／恢复提醒。')
        + 'IBKR 和嘉信登录失效提醒始终自动开启，每次失效只推送一次。';
    }
    return this.answerPersonal(text, command, state, context);
  }

  private async answerPersonal(text: string, command: string, state: DashboardState, context: ChatContext): Promise<string> {
    const { inGroup, history, speaker } = context;
    if (command === '查看偏好') return this.store.state.preferences || '尚未设置偏好。';
    if (command === '清除偏好') {
      this.store.state.preferences = ''; this.store.save();
      return '已清除偏好。';
    }
    const preference = /^偏好\s+([\s\S]+)$/.exec(text);
    if (preference) {
      if (preference[1].length > 1000) return '偏好请控制在 1000 字以内。';
      this.store.state.preferences = preference[1]; this.store.save();
      return '已保存偏好，模型启用后会在回答中参考。';
    }
    const isFx = /换汇|入金|出金|汇率|CNH|CNY/i.test(text);
    const needsAnalysis = isFx && /成本|均价|平均|亏|赚|损|对比|比较|百分|以上|以下/.test(text);
    let extra = needsAnalysis && this.source.forexAnalysis ? await this.source.forexAnalysis(text)
      : isFx && this.source.forex ? await this.source.forex() : '';
    if (/昨天|昨晚|昨日|上一(?:个)?(?:美股)?交易日/.test(text) && this.source.dailyFacts) {
      try { extra += '\n' + dailyFactsText(await this.source.dailyFacts()); }
      catch { extra += '\n上一已完成美股交易日的数据暂未齐全，不能用当前快照代替。'; }
    }
    const question = speaker ? '[' + speaker + '] ' + text : text;
    return await this.model.answer(question, state, inGroup ? '' : this.store.state.preferences, extra, history) + dataWarning(state);
  }

  async tick(now = new Date()): Promise<void> {
    const owner = this.store.state.ownerOpenId;
    if (!owner) return;
    const state = this.source.view();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: this.store.state.dailyTimeZone ?? this.config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value]));
    const day = parts.year + '-' + parts.month + '-' + parts.day;
    const time = Number(parts.hour) * 60 + Number(parts.minute);
    const scheduled = this.store.state.dailyTime;
    if (scheduled) {
      const [hour, minute] = scheduled.split(':').map(Number);
      const delay = time - hour * 60 - minute;
      // Retain the calendar-day key for existing deliveries and time changes.
      const dayKey = 'daily:' + day;
      if (delay >= 0 && delay < 60 && !this.store.delivered(dayKey, now.getTime())) {
        const reportDate = scheduledReportDate(now);
        const key = 'daily-report:' + reportDate;
        if (reportDate && !this.store.delivered(key, now.getTime())) {
          await this.transport.send(owner, await this.generateDaily(reportDate), key);
          this.store.state.delivered[key] = now.getTime();
          this.store.markDelivered(dayKey, now.getTime());
          this.activity.lastPushAt = now.toISOString();
        }
      }
    }
    await this.alert(state, now);
  }

  private async alert(state: DashboardState, now: Date): Promise<void> {
    if (!this.store.state.alerts || !state.status.connected || this.source.authStatus?.('ibkr') === 'login_required') return;
    const health = state.status.stale ? 'stale' : 'fresh';
    const previous = this.store.state.lastHealth === 'auth' ? null : this.store.state.lastHealth;
    if (previous === health) return;
    if (health !== 'fresh' || previous !== null) {
      const message = health === 'stale' ? '账户数据已过期，服务正在重试。' : 'IB 账户数据采集已恢复。';
      const key = 'alert:' + previous + ':' + health + ':' + Math.floor(now.getTime() / 3600000);
      await this.transport.send(this.store.state.ownerOpenId, message + '\n' + this.config.publicUrl + '\n\n' + freshness(state), key);
      this.activity.lastPushAt = now.toISOString();
    }
    this.store.state.lastHealth = health;
    this.store.save(now.getTime());
  }
}
