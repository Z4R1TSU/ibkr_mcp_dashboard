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
  total?: { capitalUsd: number; pnlUsd: number; returnPct: number; asOf: string | null } | null;
  today?: { date: string; previousDate: string; previousNav: number; navChange: number; changePct: number; currency: string } | null;
  history?: { latestDate: string; providerLatest: string | null; offline: boolean; records: number } | null;
  performance: {
    date: string;
    since: string | null;
    totalReturnPct: number | null;
    dailyReturnPct: number | null;
  } | null;
  warnings: string[];
  activity: PresenceActivity | null;
}
export interface DiscordStatus {
  settings: DiscordSettings;
  connected: boolean;
  lastSentAt: string | null;
  error: string | null;
  summary: PresenceSummary;
}
