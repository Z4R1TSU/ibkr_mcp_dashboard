import type { DailyFacts } from '../server/daily-data.js';
export function dailyFixture(): DailyFacts {
  return {
    date: '2026-09-25', generatedAt: '2026-09-26T03:00:00Z',
    account: { date: '2026-09-25', previousDate: '2026-09-24', currency: 'USD',
      startNav: 1000, endNav: 1010, navChange: 10, returnPct: 1, flowMismatch: false, measure: 'TWR' },
    benchmarks: [{ symbol: 'SPY', label: '标普500 ETF', date: '2026-09-25',
      close: 101, dayChangePct: 1, sessionChangePct: 0.5, corporateActions: [] }],
    holdings: [{ symbol: 'AAPL', label: 'AAPL', date: '2026-09-25',
      close: 202, dayChangePct: 2, sessionChangePct: 1, corporateActions: [] }],
    warnings: [],
  };
}
