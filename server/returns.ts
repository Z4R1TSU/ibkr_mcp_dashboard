export function capitalReturn(nav: number | null, currency: string | null, capitalUsd?: number, asOf: string | null = null) {
  if (currency !== 'USD' || nav === null || !Number.isFinite(nav) || !Number.isFinite(capitalUsd) || capitalUsd! <= 0) return null;
  const pnlUsd = nav - capitalUsd!;
  return { capitalUsd: capitalUsd!, pnlUsd, returnPct: pnlUsd / capitalUsd! * 100, asOf };
}

export function navChange(nav: number | null, currency: string | null, date: string,
  previous?: { date: string; endNav: number }) {
  if (nav === null || !Number.isFinite(nav) || !currency || !previous || !Number.isFinite(previous.endNav) || previous.endNav <= 0) return null;
  const change = nav - previous.endNav;
  return { date, previousDate: previous.date, previousNav: previous.endNav,
    navChange: change, changePct: change / previous.endNav * 100, currency };
}
