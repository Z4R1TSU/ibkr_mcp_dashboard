import type { PresenceActivity } from '../../shared/discord.js';

export function presenceArtwork(rate: number | null | undefined, date?: string): Pick<PresenceActivity,
  'largeImageKey' | 'largeImageText' | 'smallImageKey' | 'smallImageText'> {
  const known = typeof rate === 'number' && Number.isFinite(rate);
  const direction = !known || rate === 0 ? 'flat' : rate > 0 ? 'up' : 'down';
  const label = !known ? '上一交易日收益暂缺' : direction === 'up' ? '上一交易日上涨' : direction === 'down' ? '上一交易日下跌' : '上一交易日持平';
  const change = known ? ' ' + (rate >= 0 ? '+' : '') + rate.toFixed(2) + '%' : '';
  const text = (date ? date + ' · ' : '') + label + change;
  return { largeImageKey: 'portfolio_' + direction, smallImageKey: 'trend_' + direction,
    largeImageText: text + '（方向示意）', smallImageText: text };
}
