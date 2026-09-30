import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import type { BotConfig } from './config.js';
import { splitMarkdown } from './markdown.js';

export interface BotMessage {
  sender_id: string;
  sender_type: string;
  chat_type: string;
  chat_id?: string;
  mentions?: { id: string; key?: string; name?: string }[];
  message_id: string;
  message_type: string;
  content: string;
  create_time: string;
}

export interface BotTransport {
  send(openId: string, text: string, key: string): Promise<void>;
  acknowledge?(messageId: string): Promise<void>;
  sendCard?(openId: string, card: object, key: string): Promise<void>;
}

export class CliTransport implements BotTransport {
  private child?: ChildProcessWithoutNullStreams;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failures = 0;
  status = { connected: false, error: null as string | null, reactionError: null as string | null, receivedCount: 0, lastEventAt: null as string | null, lastChatType: null as string | null };
  constructor(private readonly config: BotConfig) {}
  private env() {
    const env: NodeJS.ProcessEnv = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
    delete env.MODEL_API_KEY;
    return env;
  }
  start(onMessage: (message: BotMessage) => void): void {
    this.stopped = false;
    this.connect(onMessage);
  }
  private connect(onMessage: (message: BotMessage) => void): void {
    if (this.stopped) return;
    const child = spawn(this.config.cliPath, ['--profile', this.config.profile, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'], { env: this.env(), stdio: 'pipe' });
    this.child = child;
    const deadline = setTimeout(() => child.kill('SIGTERM'), 45000);
    const out = createInterface({ input: child.stdout });
    const err = createInterface({ input: child.stderr });
    out.on('line', line => {
      if (line.length > 128000) return;
      try {
        const message = JSON.parse(line) as BotMessage;
        this.status.receivedCount++;
        this.status.lastEventAt = new Date().toISOString();
        this.status.lastChatType = ['p2p', 'group'].includes(message.chat_type) ? message.chat_type : 'unknown';
        onMessage(message);
      } catch { this.status.error = '消息格式无效'; }
    });
    err.on('line', line => {
      if (line.includes('[event] ready event_key=im.message.receive_v1')) {
        clearTimeout(deadline);
        this.status.connected = true;
        this.status.error = null;
        this.failures = 0;
      }
      try {
        const error = JSON.parse(line)?.error;
        if (error) this.status.error = '飞书连接失败：' + String(error.subtype || error.type || 'unknown').slice(0, 80);
      } catch { /* CLI diagnostics can contain message data; do not log them. */ }
    });
    child.on('error', () => { this.status.error = '无法启动 lark-cli，请检查安装和 FEISHU_CLI_PATH'; });
    child.once('close', () => {
      clearTimeout(deadline);
      out.close(); err.close();
      this.status.connected = false;
      if (!this.stopped) {
        this.status.error ??= '飞书连接断开，正在重试';
        const delay = Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6));
        this.retry = setTimeout(() => this.connect(onMessage), delay);
      }
    });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      child.once('close', () => resolve());
      child.stdin.end();
      child.kill('SIGTERM');
    });
    this.status.connected = false;
  }

  async send(openId: string, text: string, key: string): Promise<void> {
    if (!/^(ou|oc)_[a-zA-Z0-9]+$/.test(openId)) throw new Error('Invalid recipient');
    for (const [offset, content] of splitMarkdown(text).entries()) {
      const id = createHash('sha256').update(key + ':' + offset).digest('hex').slice(0, 48);
      const args = ['--profile', this.config.profile, 'im', '+messages-send', '--as', 'bot', openId.startsWith('oc_') ? '--chat-id' : '--user-id', openId,
        '--markdown', content, '--idempotency-key', id];
      await this.run(args);
    }
  }

  async acknowledge(messageId: string): Promise<void> {
    if (!/^om_[a-zA-Z0-9]+$/.test(messageId)) throw new Error('Invalid message');
    try {
      await this.run(['--profile', this.config.profile, 'im', 'reactions', 'create', '--as', 'bot',
        '--params', JSON.stringify({ message_id: messageId }),
        '--data', JSON.stringify({ reaction_type: { emoji_type: 'Get' } })], 5000);
      this.status.reactionError = null;
    } catch {
      this.status.reactionError = '收件表情发送失败，请检查网络及机器人 im:message.reactions:write_only 权限。';
    }
  }

  async sendCard(openId: string, card: object, key: string): Promise<void> {
    if (!/^(ou|oc)_[a-zA-Z0-9]+$/.test(openId)) throw new Error('Invalid recipient');
    const id = createHash('sha256').update(key + ':card').digest('hex').slice(0, 48);
    await this.run(['--profile', this.config.profile, 'im', '+messages-send', '--as', 'bot',
      openId.startsWith('oc_') ? '--chat-id' : '--user-id', openId,
      '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', id]);
  }

  private run(args: string[], timeoutMs = 30000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(this.config.cliPath, args, { env: this.env(), stdio: 'pipe' });
        let output = '';
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('Feishu request timed out')); }, timeoutMs);
        child.stdin.end();
        child.stdout.on('data', chunk => {
          output += chunk.toString();
          if (output.length > 1024 * 1024) { child.kill('SIGTERM'); finish(new Error('Feishu response too large')); }
        });
        child.stderr.resume();
        child.on('error', () => finish(new Error('Unable to run lark-cli')));
        child.on('close', code => {
          try {
            if (code !== 0 || JSON.parse(output).ok !== true) throw new Error('Send failed');
            finish();
          } catch { finish(new Error('Feishu send failed; check bot scopes and availability')); }
        });
    });
  }
}
