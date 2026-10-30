export type BrokerId = 'ibkr' | 'schwab';
export type BrokerAuthState = 'ready' | 'login_required' | 'unknown' | 'disabled';

export interface LoginAlertStatus {
  enabled: boolean;
  running: boolean;
  lastCheckAt: string | null;
  brokers: Record<BrokerId, {
    state: BrokerAuthState;
    detectedAt: string | null;
    sentAt: string | null;
    pending: boolean;
    error: string | null;
  }>;
}
