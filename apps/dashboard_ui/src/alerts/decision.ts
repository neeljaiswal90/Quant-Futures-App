import type { AlertConfig } from "@contracts/realtime/config";
import type { Tier } from "@contracts/realtime/events";
import type { FeedItem } from "../contract/render";

const COOLDOWN_MS = 5 * 60 * 1000;

export interface AlertDecision {
  audio: boolean;
  notification: boolean;
  banner: boolean;
  key: string;
  reason: string | null;
}

export interface AlertMemory {
  lastFiredByKey: Map<string, number>;
}

interface AlertDecisionInput {
  currentPrice: number | null;
  config: AlertConfig;
  nowMs: number;
  now?: Date;
  memory: AlertMemory;
}

export function createAlertMemory(): AlertMemory {
  return { lastFiredByKey: new Map() };
}

export function decideAlert(
  item: FeedItem,
  input: AlertDecisionInput,
): AlertDecision {
  const { currentPrice, config, nowMs, memory } = input;
  const now = input.now ?? new Date(nowMs);
  const empty = (reason: string): AlertDecision => ({
    audio: false,
    notification: false,
    banner: false,
    key: alertKey(item),
    reason,
  });
  if (!item.tier) return empty("missing-tier");
  const tierCfg = config[alertTier(item.tier)];
  if (!tierCfg.enabled) return empty("tier-disabled");
  if (!withinProximity(item, currentPrice, config)) return empty("outside-proximity");

  const key = alertKey(item);
  const last = memory.lastFiredByKey.get(key);
  if (last != null && nowMs - last < COOLDOWN_MS) return empty("cooldown");

  let audio = tierCfg.audio_file != null;
  let notification = tierCfg.browser_notif;
  let banner = item.tier === "CRITICAL";
  if (config.quiet_hours.enabled && inQuietHours(now, config.quiet_hours)) {
    if (config.quiet_hours.audio_only) {
      audio = false;
    } else {
      audio = false;
      notification = false;
      banner = false;
    }
  }

  if (audio || notification || banner) {
    memory.lastFiredByKey.set(key, nowMs);
  }
  return { audio, notification, banner, key, reason: null };
}

function alertTier(tier: Tier): "critical" | "high" | "medium" {
  return tier.toLowerCase() as "critical" | "high" | "medium";
}

function proximityFor(tier: Tier, config: AlertConfig): number {
  if (tier === "CRITICAL") return config.proximity.critical_pt;
  if (tier === "HIGH") return config.proximity.high_pt;
  return config.proximity.medium_pt;
}

function withinProximity(
  item: FeedItem,
  currentPrice: number | null,
  config: AlertConfig,
): boolean {
  if (!item.tier) return false;
  if (item.price == null || currentPrice == null) return true;
  return Math.abs(item.price - currentPrice) <= proximityFor(item.tier, config);
}

function alertKey(item: FeedItem): string {
  const priceBucket = item.price == null ? "session" : Math.round(item.price / 0.25) * 0.25;
  return [
    item.family,
    item.levelId ?? priceBucket,
    item.side ?? item.direction ?? "",
    item.tier ?? "",
  ].join("|");
}

function inQuietHours(
  now: Date,
  window: AlertConfig["quiet_hours"],
): boolean {
  const nowMinutes = ptMinutes(now);
  const start = clockMinutes(window.start_pt);
  const end = clockMinutes(window.end_pt);
  if (start == null || end == null) return false;
  if (start === end) return true;
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end;
}

function clockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function ptMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export const alertDecisionInternals = { inQuietHours, withinProximity, alertKey };
