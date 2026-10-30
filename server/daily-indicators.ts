import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface FearGreedReading { value: number; date: string; source: string; url: string }
export interface ValuationReading { value: number; date: string; percentile10y: number; source: string; url: string }
export interface DailyIndicators {
  fearGreed: FearGreedReading | null;
  pe: ValuationReading | null;
  forwardPe: ValuationReading | null;
  warnings: string[];
}
export interface ValuationPage { heading: string; text: string; headers: string[]; rows: string[][] }
const TRENDONIFY = 'https://trendonify.com/united-states/stock-market/nasdaq-100/';
const FEAR_GREED = 'https://feargreedmeter.com/fear-and-greed-index';
const DAY = 86400000;
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function parseTrendonify(page: unknown, forward = false): ValuationReading {
  const p = page as ValuationPage;
  const heading = forward ? 'NASDAQ-100 Forward PE Ratio' : 'NASDAQ-100 PE Ratio';
  if (p?.heading !== heading || typeof p.text !== 'string' || !Array.isArray(p.headers) || !Array.isArray(p.rows)) throw new Error('估值网页不完整');
  const match = new RegExp(heading + '\\s+([0-9]+(?:\\.[0-9]+)?)\\s+Last Updated:\\s+([A-Za-z]+ \\d{1,2}, \\d{4})', 'i').exec(p.text);
  if (!match) throw new Error('估值或更新日期缺失');
  const time = Date.parse(match[2] + ' UTC');
  const date = Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
  const value = Number(match[1]);
  const periodColumn = p.headers.findIndex(h => h.toLowerCase() === 'time period');
  const percentileColumn = p.headers.findIndex(h => h.toLowerCase() === 'percentile rank');
  const rows = p.rows.filter(row => Array.isArray(row) && row[periodColumn] === '10 Year');
  const cell = rows.length === 1 && percentileColumn >= 0 ? rows[0][percentileColumn] : '';
  const percentile10y = typeof cell === 'string' && /^\d+(?:\.\d+)?%?$/.test(cell) ? Number(cell.replace('%', '')) : NaN;
  if (!validDate(date) || !finite(value) || value <= 0 || !finite(percentile10y) || percentile10y < 0 || percentile10y > 100) throw new Error('估值或十年分位数无效');
  return { value, date, percentile10y, source: 'Trendonify', url: TRENDONIFY + (forward ? 'forward-pe-ratio' : 'pe-ratio') };
}

export function parseFearGreed(html: string, reportDate: string): FearGreedReading {
  if (!validDate(reportDate)) throw new Error('日报日期无效');
  const json = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!json) throw new Error('情绪网页数据缺失');
  const rows = JSON.parse(json)?.props?.pageProps?.data?.fgiData?.fgi;
  if (!Array.isArray(rows)) throw new Error('CNN 情绪序列缺失');
  const row = rows.filter(row => validDate(row?.date) && row.date <= reportDate && finite(row.now) && row.now >= 0 && row.now <= 100)
    .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (!row) throw new Error('目标日期的 CNN 指数缺失');
  return { value: row.now, date: row.date, source: 'CNN（FearGreedMeter 转载）', url: FEAR_GREED };
}

export function fearGreedLabel(value: number): string {
  return value < 25 ? '极度恐惧' : value < 45 ? '恐惧' : value <= 55 ? '中性' : value < 75 ? '贪婪' : '极度贪婪';
}

interface IndicatorSources {
  fearGreed(): Promise<string>;
  valuations(): Promise<unknown>;
}
async function publicPage(): Promise<string> {
  const response = await fetch(FEAR_GREED, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('情绪网页不可用');
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error('情绪网页格式异常');
  return html;
}
async function valuationPages(directory: string): Promise<unknown> {
  const keys = ['PATH', 'HOME', 'USER', 'LANG', 'XDG_CACHE_HOME', 'TMPDIR',
    'DAILY_CHROMIUM_PATH', 'DAILY_XVFB_PATH', 'DAILY_BROWSER_LIBRARY_PATH'];
  const env = Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const { stdout } = await promisify(execFile)(process.execPath,
    [path.resolve('scripts/daily-indicators-browser.mjs'), path.join(directory, 'daily-market-browser')],
    { env, timeout: 150000, maxBuffer: 512 * 1024 });
  return JSON.parse(stdout);
}

function usable(reading: FearGreedReading | ValuationReading | null, date: string): boolean {
  return Boolean(reading && finite(reading.value) && validDate(reading.date) && reading.date <= date
    && Date.parse(date) - Date.parse(reading.date) <= 7 * DAY);
}

interface SavedIndicators { version: 1; date: string; checkedAt: number; data: DailyIndicators }
export class MarketIndicators {
  private cached?: SavedIndicators;
  private pending = new Map<string, Promise<DailyIndicators>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly sources: IndicatorSources;
  constructor(private readonly directory: string, sources?: IndicatorSources, private readonly clock = Date.now) {
    this.file = path.join(directory, 'daily-market-indicators.json');
    this.sources = sources ?? { fearGreed: publicPage, valuations: () => valuationPages(directory) };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const reading = (value: any, valuation = false) => value === null || (usable(value, saved.date)
        && typeof value.source === 'string' && typeof value.url === 'string'
        && (valuation ? value.value > 0 && finite(value.percentile10y) && value.percentile10y >= 0 && value.percentile10y <= 100 : value.value >= 0 && value.value <= 100));
      if (saved.version === 1 && validDate(saved.date) && finite(saved.checkedAt) && saved.data
        && reading(saved.data.fearGreed) && reading(saved.data.pe, true) && reading(saved.data.forwardPe, true)
        && Array.isArray(saved.data.warnings) && saved.data.warnings.every((w: unknown) => typeof w === 'string')) this.cached = saved;
    } catch { /* An absent or invalid cache is refreshed from public pages. */ }
  }
  get(date: string): Promise<DailyIndicators> {
    if (!validDate(date)) return Promise.reject(new Error('日报日期无效'));
    const cache = this.cached;
    if (cache?.date === date && cache.checkedAt <= this.clock() && this.clock() - cache.checkedAt < 15 * 60000) return Promise.resolve(cache.data);
    const running = this.pending.get(date);
    if (running) return running;
    const result = this.queue.then(() => this.refresh(date));
    this.queue = result.catch(() => undefined);
    this.pending.set(date, result);
    void result.finally(() => this.pending.delete(date)).catch(() => {});
    return result;
  }
  private async refresh(date: string): Promise<DailyIndicators> {
    const old = this.cached?.data;
    const data: DailyIndicators = {
      fearGreed: old?.fearGreed && usable(old.fearGreed, date) ? old.fearGreed : null,
      pe: old?.pe && usable(old.pe, date) ? old.pe : null,
      forwardPe: old?.forwardPe && usable(old.forwardPe, date) ? old.forwardPe : null,
      warnings: [],
    };
    const [fear, valuations] = await Promise.allSettled([this.sources.fearGreed(), this.sources.valuations()]);
    const unavailable = (key: 'fearGreed' | 'pe' | 'forwardPe', label: string) => {
      data.warnings.push(label + '网页暂不可用' + (data[key] ? '，使用 ' + data[key]!.date + ' 的缓存' : ''));
    };
    try {
      if (fear.status !== 'fulfilled') throw new Error('Unavailable');
      const reading = parseFearGreed(fear.value, date);
      if (!usable(reading, date)) throw new Error('Outdated');
      data.fearGreed = reading;
    } catch { unavailable('fearGreed', 'CNN 指数'); }
    for (const [key, forward] of [['pe', false], ['forwardPe', true]] as const) {
      try {
        if (valuations.status !== 'fulfilled') throw new Error('Unavailable');
        const pages = valuations.value as Record<string, unknown>;
        const reading = parseTrendonify(pages[forward ? 'forward-pe-ratio' : 'pe-ratio'], forward);
        if (!usable(reading, date)) throw new Error('Wrong date');
        data[key] = reading;
      } catch { unavailable(key, forward ? 'NDX Forward PE' : 'NDX PE'); }
    }
    this.cached = { version: 1, date, checkedAt: this.clock(), data };
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.cached), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    } catch { /* Public-data cache failures do not prevent the account report. */ }
    return data;
  }
}
