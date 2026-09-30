import { execFileSync } from 'node:child_process';
import { Vault } from '../server/vault.js';
import { config } from '../server/config.js';
import { validateReadScope } from '../server/ibkr.js';

if (process.platform !== 'darwin') throw new Error('此导入仅适用于 macOS；服务器请在看板中重新授权');
const account = process.argv[2];
if (!account || !account.startsWith('ibkr|')) throw new Error('请传入已核实的 IBKR 钥匙串条目名称');
const serialized = execFileSync('security', ['find-generic-password', '-s', 'Codex MCP Credentials', '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const imported = JSON.parse(serialized);
if (imported.url !== config.serverUrl || imported.server_name !== 'ibkr') throw new Error('凭据不属于官方 IBKR MCP');
validateReadScope(imported.token_response?.scope);
if (!imported.token_response?.access_token || !imported.client_id) throw new Error('凭据不完整');
const vault = new Vault();
vault.update(value => {
  value.oauth = {
    client: { client_id: imported.client_id },
    tokens: imported.token_response,
    expiresAt: imported.expires_at ? (imported.expires_at > 1e12 ? imported.expires_at : imported.expires_at * 1000) : undefined,
  };
});
vault.ensureAdmin();
console.log('已导入 IBKR 只读授权。凭据已加密保存，未打印令牌。');
