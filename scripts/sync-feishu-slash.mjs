import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../dist/server/config.js';
import { SLASH_COMMANDS } from '../dist/server/bot/slash-commands.js';

const profile = process.env.FEISHU_PROFILE;
const cli = process.env.FEISHU_CLI_PATH || 'lark-cli';
if (!profile || !/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error('Set a dedicated FEISHU_PROFILE first');
const env = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
delete env.MODEL_API_KEY;
function call(args) {
  const result = spawnSync(cli, ['--profile', profile, ...args], { encoding: 'utf8', env, timeout: 45000 });
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('Feishu CLI did not return JSON'); }
  if (result.error || result.status !== 0 || value.ok === false) throw new Error('Feishu CLI failed: ' + [value.error?.type, value.error?.subtype, value.error?.code].filter(Boolean).join('/'));
  return value;
}
const identity = call(['whoami', '--as', 'bot']);
if (identity.identity !== 'bot' || !/^cli_[A-Za-z0-9]+$/.test(identity.appId || '')) throw new Error('Cannot verify the bot application');
function list() {
  const value = call(['application', '+slash-command-list', '--as', 'bot']);
  if (!Array.isArray(value.data?.items)) throw new Error('Invalid command list');
  return value.data.items;
}
const existing = list();
const byName = new Map(existing.map(command => [command.command, command]));
const missing = SLASH_COMMANDS.filter(command => !byName.has(command.name));
if (existing.length + missing.length > 100) throw new Error('Application would exceed the 100 command limit');
console.log(JSON.stringify({ appId: identity.appId, profile, plan: SLASH_COMMANDS.map(command => ({ command: command.name, description: command.description, action: byName.has(command.name) ? 'keep' : 'create', commandId: byName.get(command.name)?.command_id })) }, null, 2));
if (!process.argv.includes('--apply')) process.exit(0);
const file = path.join(config.dataDir, 'feishu-slash-commands.json');
function save() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, profile, appId: identity.appId, updatedAt: new Date().toISOString(), commands: [...byName.values()] }, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
save();
let createdCount = 0;
for (const command of missing) {
  let created;
  try {
    const result = call(['application', '+slash-command-create', '--as', 'bot', '--command', command.name, '--description', command.description]);
    if (!result.data?.command_id) throw new Error('Create did not return a command ID');
    createdCount++;
    created = { command: command.name, command_id: result.data.command_id, description: { default_value: command.description } };
  } catch (error) {
    created = list().find(item => item.command === command.name);
    if (!created) throw error;
  }
  byName.set(command.name, created);
  save();
}
const verified = list();
for (const command of SLASH_COMMANDS) if (!verified.some(item => item.command === command.name)) throw new Error('Missing registered command: ' + command.name);
for (const command of verified) byName.set(command.command, command);
save();
console.log(JSON.stringify({ registered: SLASH_COMMANDS.length, created: createdCount, metadataFile: file }));
