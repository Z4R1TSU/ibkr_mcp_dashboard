import fs from 'node:fs';
import path from 'node:path';
import { Vault } from '../server/vault.js';
import { config } from '../server/config.js';
import { IbkrClient, IbkrOAuth } from '../server/ibkr.js';

const client = new IbkrClient(new IbkrOAuth(new Vault()));
function shape(value: unknown, depth = 0): unknown {
  if (depth > 4) return typeof value;
  if (Array.isArray(value)) return { length: value.length, item: value.length ? shape(value[0], depth + 1) : null };
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child, depth + 1)]));
  return typeof value;
}
try {
  for (const tool of ['get_account_positions', 'get_account_summary', 'get_account_balances']) {
    const value = await client.call(tool);
    fs.writeFileSync(path.join(config.dataDir, tool + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ tool, shape: shape(value) }));
  }
} finally {
  await client.disconnect();
}
