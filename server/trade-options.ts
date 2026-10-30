import type { Trade } from '../shared/trades.js';

export function optionRight(value: unknown): 'P' | 'C' | null {
  if (typeof value !== 'string') return null;
  const upper = value.toUpperCase(), rights = new Set<string>();
  if (upper === 'P' || upper === 'C') return upper;
  for (const word of upper.match(/\b(PUT|CALL)\b/g) ?? []) rights.add(word === 'PUT' ? 'P' : 'C');
  for (const match of upper.matchAll(/\b[A-Z0-9.]+\s+\d{6}([CP])\d{8}\b/g)) rights.add(match[1]);
  return rights.size === 1 ? [...rights][0] as 'P' | 'C' : null;
}

export interface TradeAnnotation { symbol: string; time: string; side: string; right: 'P' | 'C' }
export const orderId = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && /^\d+$/.test(value) ? value : null;

export function enrichOrderTypes(trades: Trade[], raw: unknown): Trade[] {
  const rows = (raw as { orders?: unknown })?.orders;
  if (!Array.isArray(rows)) return trades;
  const orders = new Map(rows.map(row => [orderId(row?.order_id), row]));
  return trades.map(t => {
    if (t.optionRight || !t.orderId || !['OPT', 'FOP'].includes(t.assetClass ?? '')) return t;
    const order = orders.get(t.orderId), description = order?.primary_description;
    if (!t.symbol || typeof description !== 'string' || order.side !== t.side || !description.split(/\s+/).includes(t.symbol)) return t;
    const right = optionRight(description);
    return right ? { ...t, optionRight: right, optionSource: 'order', contractDescription: description } : t;
  });
}

export function annotateTrades(trades: Trade[], annotations: Record<string, TradeAnnotation>): Trade[] {
  return trades.map(t => {
    const a = annotations[t.id];
    if (t.optionRight || !['OPT', 'FOP'].includes(t.assetClass ?? '') || !a || !['P', 'C'].includes(a.right) || a.symbol !== t.symbol || a.time !== t.time || a.side !== t.side) return t;
    return { ...t, optionRight: a.right, optionSource: 'user' };
  });
}
