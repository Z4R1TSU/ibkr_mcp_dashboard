import type { CashFlow, CashFlowsState } from './cash-flows.js';

export const PNL_TIME_ZONE = 'America/New_York';

export interface PnlCalendarDay {
  cashFlows?: CashFlow[];
  date: string;
  status: 'available' | 'missing' | 'closed' | 'future';
  pnl: number | null;
  returnPct: number | null;
  startNav: number | null;
  endNav: number | null;
  navChange: number | null;
  previousDate: string | null;
  issue: 'cash-flow' | 'date-gap' | null;
  provisional: boolean;
  asOf: string | null;
  source: 'ib-pa' | 'daily-report' | 'local-snapshot' | null;
}

export interface PnlCalendar {
  cashFlows?: CashFlowsState;
  month: string;
  today: string;
  timeZone: string;
  currency: string | null;
  earliestDate: string | null;
  latestDate: string | null;
  updatedAt: string | null;
  refreshing: boolean;
  offline: boolean;
  days: PnlCalendarDay[];
  summary: {
    pnl: number | null;
    /** Calendar-month-to-date TWR, through the latest available valuation. */
    returnPct: number | null;
    returnThroughDate: string | null;
    amountDays: number;
    recordedDays: number;
    expectedDays: number;
    profitDays: number;
    lossDays: number;
    flatDays: number;
    provisional: boolean;
  };
}

export function isCalendarMonth(value: unknown): value is string {
  return typeof value === 'string' && /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value);
}

export function calendarDates(month: string): string[] {
  if (!isCalendarMonth(month)) throw new Error('无效的日历月份');
  const [year, part] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, part, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export function shiftCalendarMonth(month: string, offset: number): string {
  const date = new Date(month + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
