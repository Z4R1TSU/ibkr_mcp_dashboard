import 'dotenv/config';
import { ResearchQuotes } from '../server/research/quotes.js';

const symbol = (process.argv[2] || 'GOOG').toUpperCase();
if (!/^[A-Z]{1,10}$/.test(symbol)) throw new Error('Provide a US stock symbol');
// Public market data only: no account read, model request, or Feishu message.
const result = await new ResearchQuotes().get(symbol, AbortSignal.timeout(15000));
console.log(JSON.stringify(result, null, 2));
if (!result.quote) process.exitCode = 1;
