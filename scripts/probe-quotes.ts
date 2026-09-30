import fs from 'node:fs';
import path from 'node:path';
import { Vault } from '../server/vault.js';
import { config } from '../server/config.js';
import { IbkrClient, IbkrOAuth } from '../server/ibkr.js';

const client = new IbkrClient(new IbkrOAuth(new Vault()));
try {
  const saved = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'get_account_positions.json'), 'utf8'));
  for (const position of [saved.positions[0], saved.positions.find((value: { asset_class?: string }) => !value.asset_class)]) {
    const quote = await client.call('get_price_snapshot', { contract_id: position.contract_id, market_data_names: ['last', 'bid_ask', 'top_status', 'plprice'] });
    fs.writeFileSync(path.join(config.dataDir, `quote-${position.contract_id}.json`), JSON.stringify(quote, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ contract: position.contract_id, quote }));
  }
} finally {
  await client.disconnect();
}
