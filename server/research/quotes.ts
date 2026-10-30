import fs from 'node:fs';
import path from 'node:path';
import type { IbkrClient } from '../ibkr.js';
import type { Position } from '../../shared/types.js';
import { normalizeQuote } from '../normalize.js';
import { isUsEquityTradingDate, previousUsEquityTradingDate, usEquityCloseHour } from '../us-market-calendar.js';

export interface PriceObservation {
  value: number; receivedAt: string; sourceTime: string | null;
}
export interface ResearchQuote {
  symbol: string; currency: 'USD'; source: 'thinkorswim' | 'ibkr';
  status: 'REALTIME' | 'DELAYED' | 'UNKNOWN';
  fields: Partial<Record<'mark' | 'last' | 'bid' | 'ask' | 'regularClose' | 'regularLast', PriceObservation>>;
  lastIsClose: boolean | null;
  reference: PriceObservation & { kind: 'mark' | 'last' | 'midpoint' };
}
export interface ResearchMarketContext {
  version: 1; symbol: string; requestedAt: string; expectedSettledDate: string;
  session: 'regular' | 'pre' | 'post' | 'overnight' | 'closed';
  quote: ResearchQuote | null;
  failures: { source: string; reason: string }[];
}
export type ResearchQuoteSource = (symbol: string, signal: AbortSignal) => Promise<ResearchMarketContext>;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const fresh = (time: unknown, now: number) => typeof time === 'string' && now - Date.parse(time) >= -5000 && now - Date.parse(time) <= 120000;

export function researchSession(now: Date): Pick<ResearchMarketContext, 'session' | 'expectedSettledDate'> {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const date = p.year + '-' + p.month + '-' + p.day, minute = Number(p.hour) * 60 + Number(p.minute);
  const trading = isUsEquityTradingDate(date), close = usEquityCloseHour(date) * 60;
  return {
    expectedSettledDate: trading && minute >= close + 15 ? date : previousUsEquityTradingDate(date),
    session: !trading ? 'closed' : minute < 240 || minute >= 1200 ? 'overnight'
      : minute < 570 ? 'pre' : minute < close ? 'regular' : 'post',
  };
}

export function selectReference(fields: ResearchQuote['fields'], lastIsClose: boolean | null, now: number): ResearchQuote['reference'] {
  const usable = (row: PriceObservation | undefined) => row && positive(row.value) && fresh(row.receivedAt, now);
  if (usable(fields.mark)) return { ...fields.mark!, kind: 'mark' };
  if (lastIsClose !== true && usable(fields.last)) {
    const last = fields.last!;
    if (!last.sourceTime || fresh(last.sourceTime, now)) return { ...last, kind: 'last' };
  }
  if (usable(fields.bid) && usable(fields.ask) && fields.bid!.value <= fields.ask!.value) {
    return { value: (fields.bid!.value + fields.ask!.value) / 2,
      receivedAt: fields.bid!.receivedAt < fields.ask!.receivedAt ? fields.bid!.receivedAt : fields.ask!.receivedAt,
      sourceTime: null, kind: 'midpoint' };
  }
  throw new Error('最新报价字段缺失或过期，不能用收盘价替代');
}

export function tosResearchQuote(symbol: string, body: any, now: number): ResearchQuote {
  const row = body?.quote;
  if (body?.disconnected || row?.symbol !== symbol || row?.provider !== 'thinkorswim') throw new Error('嘉信报价连接或证券不匹配');
  const fields: ResearchQuote['fields'] = {};
  for (const [key, field] of Object.entries({ mark: 'MARK', last: 'LAST', bid: 'BID', ask: 'ASK', regularLast: 'LAST_RTH' })) {
    const value = row.values?.[field], receivedAt = row.fieldTimes?.[field];
    if (positive(value) && fresh(receivedAt, now)) fields[key as keyof typeof fields] = { value, receivedAt, sourceTime: row.sourceTime ?? null };
  }
  return { symbol, currency: 'USD', source: 'thinkorswim', fields, lastIsClose: null,
    status: row.isDelayed === false ? 'REALTIME' : row.isDelayed === true ? 'DELAYED' : 'UNKNOWN',
    reference: selectReference(fields, null, now) };
}

/** IB credentials and contract IDs remain in Node, outside the worker. */
export class ResearchQuotes {
  constructor(private readonly client?: Pick<IbkrClient, 'call'>,
    private readonly positions: () => Position[] = () => [],
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly request: typeof fetch = fetch, private readonly clock = Date.now) {}

  private async tos(symbol: string, signal: AbortSignal): Promise<ResearchQuote> {
    if (!/^[A-Z]{1,10}$/.test(symbol)) throw new Error('嘉信不支持该代码格式');
    const url = new URL(this.env.TOS_MARKET_URL || 'http://127.0.0.1:8051');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('嘉信行情地址必须为本机接口');
    const file = path.join(path.resolve(this.env.TOS_DATA_DIR || path.join(this.env.DATA_DIR || 'data', 'thinkorswim')), 'api-key.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error('嘉信本机密钥权限无效');
    const key = JSON.parse(fs.readFileSync(file, 'utf8')).key;
    if (typeof key !== 'string' || !key) throw new Error('嘉信本机密钥缺失');
    url.pathname = '/v1/quote'; url.searchParams.set('symbol', symbol);
    const response = await this.request(url, { headers: { Authorization: 'Bearer ' + key },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
    if (!response.ok) throw new Error('嘉信即时报价 HTTP ' + response.status);
    return tosResearchQuote(symbol, await response.json(), this.clock());
  }

  private async ib(symbol: string, signal: AbortSignal): Promise<ResearchQuote> {
    if (!this.client) throw new Error('IB 备用报价客户端未配置');
    const held = this.positions().filter(p => p.symbol === symbol && p.kind === 'stock' && p.currency === 'USD');
    let id = held.length === 1 ? held[0].id : undefined;
    if (!id) {
      const data = await this.client.call('search_contracts', { query: symbol }, { signal }) as any;
      const matches = data?.results?.filter((r: any) => r.symbol === symbol && r.country_code === 'US'
        && (!r.currency || r.currency === 'USD') && r.sections?.some((s: any) => s.security_type === 'STK'));
      if (!Array.isArray(matches) || matches.length !== 1 || !Number.isSafeInteger(matches[0].underlying_contract_id))
        throw new Error('IB 美股合约匹配不唯一');
      id = matches[0].underlying_contract_id as number;
    }
    const raw = await this.client.call('get_price_snapshot', { contract_id: id,
      market_data_names: ['last', 'bid_ask', 'top_status', 'plprice'] }, { signal });
    const receivedAt = new Date(this.clock()).toISOString(), q = normalizeQuote(id, raw, receivedAt);
    const fields: ResearchQuote['fields'] = {};
    for (const key of ['mark', 'last', 'bid', 'ask'] as const) {
      if (positive(q[key])) fields[key] = { value: q[key], receivedAt, sourceTime: key === 'last' ? q.lastTradeAt : null };
    }
    if (q.lastIsClose && fields.last) { fields.regularClose = fields.last; delete fields.last; delete fields.mark; }
    return { symbol, currency: 'USD', source: 'ibkr', fields, lastIsClose: q.lastIsClose,
      status: q.status === 'REALTIME' ? 'REALTIME' : q.status === 'DELAYED' ? 'DELAYED' : 'UNKNOWN',
      reference: selectReference(fields, q.lastIsClose, this.clock()) };
  }

  readonly get: ResearchQuoteSource = async (symbol, signal) => {
    const now = new Date(this.clock());
    const context: ResearchMarketContext = { version: 1, symbol, requestedAt: now.toISOString(),
      ...researchSession(now), quote: null, failures: [] };
    for (const source of ['thinkorswim', 'ibkr'] as const) {
      signal.throwIfAborted();
      try {
        context.quote = await (source === 'thinkorswim' ? this.tos(symbol, signal)
          : this.ib(symbol, AbortSignal.any([signal, AbortSignal.timeout(45000)])));
        break;
      } catch (error) {
        signal.throwIfAborted();
        // Never persist broker errors containing request URLs or credentials.
        const message = error instanceof Error ? error.message : '';
        const reason = /^(嘉信|IB |最新报价)/.test(message) ? message : '报价读取失败（' + (error instanceof Error ? error.name : 'Error') + '）';
        context.failures.push({ source, reason });
      }
    }
    return context;
  };
}
