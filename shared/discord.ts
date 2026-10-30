export interface DiscordSettings {
  enabled: boolean;
  applicationId: string;
  startDate: string;
  capitalUsd?: number;
  depositsCnh?: number;
  capitalConfirmedAt?: string;
}
export interface PresenceActivity {
  name?: string; details: string; state: string;
  largeImageKey?: string; largeImageText?: string;
  smallImageKey?: string; smallImageText?: string;
}
export interface PresenceSummary {
  version: 1;
  generatedAt: string;
  accountAsOf: string | null;
  startDate: string;
  days: number | null;
  nav: number | null;
  currency: string | null;
  stale: boolean;
  todayPnl?: {
    date: string;
    status: 'before_premarket' | 'closed' | 'pending' | 'stale' | 'flow_mismatch' | 'ready';
    amount: number | null;
    asOf: string | null;
  };
  yesterdayDate?: string;
  yesterday?: FrozenPresenceDay | null;
  total?: { capitalUsd: number; pnlUsd: number; returnPct: number; asOf: string | null } | null;
  today?: { date: string; previousDate: string; previousNav: number; navChange: number; changePct: number; currency: string } | null;
  history?: { latestDate: string; providerLatest: string | null; offline: boolean; records: number } | null;
  performance: {
    date: string;
    since: string | null;
    totalReturnPct: number | null;
    dailyReturnPct: number | null;
    provisional?: boolean;
    updatedAt?: string;
  } | null;
  warnings: string[];
  activity: PresenceActivity | null;
}
export interface FrozenPresenceDay {
  previousDate?: string;
  source?: 'feishu-report' | 'noon-cutoff';
  sealed?: boolean;
  cutoffAt?: string;
  date: string;
  currency: string;
  returnPct: number;
  startNav: number;
  endNav: number;
  sourceFetchedAt: string;
  capturedAt: string;
}
export interface DiscordStatus {
  transport?: 'local' | 'remote';
  macDownloadAvailable?: boolean;
  settings: DiscordSettings;
  connected: boolean;
  lastSentAt: string | null;
  error: string | null;
  summary: PresenceSummary;
}
