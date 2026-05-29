/**
 * Alert-config contract — TypeScript mirror of config.py (RA-067 stub).
 *
 * Shape frozen by RA-067 so RA-061 (settings UI) and RA-062 (daemon) bind
 * to it during the parallel phase. RA-063 finalizes persistence + serving.
 * Kept in sync with config.py by tests/test_parity.py.
 */

export const CONFIG_SCHEMA_VERSION = 1;

export const ALERT_TIERS = ["critical", "high", "medium"] as const;
export const ALERT_TIER_FIELDS = [
  "enabled",
  "audio_file",
  "browser_notif",
  "windows_toast",
] as const;

export type AlertTier = (typeof ALERT_TIERS)[number];

export interface TierAlertConfig {
  enabled: boolean;
  audio_file: string | null;
  browser_notif: boolean;
  windows_toast: boolean;
}

export interface ProximityConfig {
  critical_pt: number;
  high_pt: number;
  medium_pt: number;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start_pt: string;
  end_pt: string;
  audio_only: boolean;
}

export interface AlertConfig {
  schema_version: number;
  critical: TierAlertConfig;
  high: TierAlertConfig;
  medium: TierAlertConfig;
  proximity: ProximityConfig;
  quiet_hours: QuietHoursConfig;
}
