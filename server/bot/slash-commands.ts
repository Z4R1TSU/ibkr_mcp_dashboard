export interface SlashCommand {
  name: string;
  description: string;
  usage: string;
  text?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'help', description: '查看持仓助手命令和用法。', usage: '/help', text: '帮助' },
  { name: 'login', description: '获取 IB 只读授权入口与恢复步骤，仅管理员私聊。', usage: '/login', text: '连接 IB' },
  { name: 'dashboard', description: '查看账户与持仓卡片。', usage: '/dashboard', text: '看板' },
  { name: 'summary', description: '查看净值、现金和账户摘要。', usage: '/summary', text: '摘要' },
  { name: 'positions', description: '查看持仓数量、市值和未实现盈亏。', usage: '/positions', text: '持仓' },
  { name: 'risk', description: '查看集中度、保证金和期权风险。', usage: '/risk', text: '风险' },
  { name: 'expiry', description: '查看期权到期与行权资金需求。', usage: '/expiry', text: '到期' },
  { name: 'fx', description: '查看本年换汇记录。', usage: '/fx', text: '今年换汇' },
  { name: 'status', description: '查看 IB、模型和推送状态。', usage: '/status', text: '状态' },
  { name: 'refresh', description: '刷新账户数据，保留现有限流。', usage: '/refresh', text: '刷新' },
  { name: 'daily', description: '查看日报；HH:MM 订阅北京时间日报，off 取消，仅私聊。', usage: '/daily [HH:MM|off]' },
  { name: 'alerts', description: 'on/off 控制数据过期与恢复提醒；登录失效始终自动提醒，仅私聊。', usage: '/alerts on|off' },
  { name: 'memory', description: 'clear 清空当前对话记忆，群聊仅管理员可操作。', usage: '/memory clear' },
  { name: 'research', description: 'TradingAgents 只读研究；股票代码或 help/status/report/cancel。', usage: '/research AAPL|help|status|report|cancel' },
];

export function resolveSlashCommand(text: string): { text: string } | { error: string } | null {
  const input = text.trim();
  if (!input.startsWith('/')) return null;
  if (input === '/') return { text: '帮助' };
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(input);
  const definition = SLASH_COMMANDS.find(command => command.name === match?.[1].toLowerCase());
  if (!definition) return { error: '未知斜杠命令。发送 /help 查看持仓助手命令。' };
  const args = match?.[2]?.trim() ?? '';
  const usage = { error: '用法：' + definition.usage };
  if (definition.text) return args ? usage : { text: definition.text };
  if (definition.name === 'research') return { text: '/research' + (args ? ' ' + args : '') };
  if (definition.name === 'memory') return args.toLowerCase() === 'clear' ? { text: '清空上下文' } : usage;
  if (definition.name === 'alerts') return args.toLowerCase() === 'on' ? { text: '开启提醒' } : args.toLowerCase() === 'off' ? { text: '关闭提醒' } : usage;
  if (definition.name !== 'daily') return usage;
  if (!args) return { text: '日报' };
  if (args.toLowerCase() === 'off') return { text: '取消日报' };
  if (/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(args)) return { text: '订阅日报北京时间 ' + args.padStart(5, '0') + ' 发送' };
  return usage;
}

export const SLASH_HELP = SLASH_COMMANDS.map(command => command.usage + '：' + command.description).join('\n');
