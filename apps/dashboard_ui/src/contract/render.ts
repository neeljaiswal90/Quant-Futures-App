/**
 * Pure family -> presentation mapping.
 *
 * Everything here is canvas-free and deterministic so it can be unit-tested
 * without lightweight-charts or the DOM. The chart layer (Phase 2/3) consumes
 * these descriptors; it owns no mapping logic of its own.
 *
 * HARD RULE: the backend owns signal logic. Nothing here re-derives a signal
 * — we only translate a contract payload into colors / labels / glyphs.
 */
import type {
  RealtimeMessage,
  RealtimePayload,
  Tier,
  ZoneState,
} from "@contracts/realtime/events";
import {
  isAbsorption,
  isIceberg,
  isSignal,
  isSweep,
  isVolRegime,
} from "./guards";

export const MNQ_TICK = 0.25;

/** Format an MNQ price to the 0.25-tick grid (2 decimals, tick-snapped). */
export function formatMnqPrice(price: number): string {
  const snapped = Math.round(price / MNQ_TICK) * MNQ_TICK;
  return snapped.toFixed(2);
}

// --- Zone color mapping ----------------------------------------------------
//
// Convention (KEY FACTS): RED = short/supply, GREEN = long/demand,
// YELLOW = no-trade/VPOC. vpoc/vah/val=yellow, sigma1/sigma2=neutral bands,
// demand=green, supply=red, wvwap=distinct.

export type ZoneColorRole =
  | "vpoc"
  | "sigma"
  | "demand"
  | "supply"
  | "wvwap"
  | "neutral";

export interface ZoneStyle {
  role: ZoneColorRole;
  color: string;
  /** Dashed for derived/structural bands, solid for primary levels. */
  dashed: boolean;
}

const ZONE_COLORS: Record<ZoneColorRole, string> = {
  vpoc: "#e3b341", // yellow — no-trade / value reference
  sigma: "#8b949e", // neutral grey band
  demand: "#3fb950", // green — long
  supply: "#f85149", // red — short
  wvwap: "#a371f7", // distinct violet
  neutral: "#6e7681",
};

export function zoneColorRole(kind: string): ZoneColorRole {
  switch (kind) {
    case "vpoc":
    case "vah":
    case "val":
      return "vpoc";
    case "sigma1":
    case "sigma2":
      return "sigma";
    case "demand":
      return "demand";
    case "supply":
      return "supply";
    case "wvwap":
      return "wvwap";
    default:
      return "neutral";
  }
}

export function zoneStyle(kind: string): ZoneStyle {
  const role = zoneColorRole(kind);
  const dashed = role === "sigma" || role === "wvwap";
  return { role, color: ZONE_COLORS[role], dashed };
}

/** A price-line descriptor for the chart layer (no chart types leaked here). */
export interface PriceLineDescriptor {
  id: string;
  price: number;
  color: string;
  dashed: boolean;
  title: string;
}

export function zoneToPriceLine(zone: ZoneState): PriceLineDescriptor {
  const style = zoneStyle(zone.kind);
  return {
    id: zone.id,
    price: zone.price,
    color: style.color,
    dashed: style.dashed,
    title: zone.label ?? zone.kind.toUpperCase(),
  };
}

// --- zone_update merge-by-id ----------------------------------------------
//
// zone_update is an additive replace-by-id, NOT a wipe: a 1-zone update must
// not erase the snapshot's other zones.

export function mergeZones(
  existing: ZoneState[],
  incoming: ZoneState[],
): ZoneState[] {
  const byId = new Map<string, ZoneState>();
  for (const z of existing) byId.set(z.id, z);
  for (const z of incoming) byId.set(z.id, z);
  return [...byId.values()];
}

// --- Event marker mapping --------------------------------------------------

export type MarkerPosition = "aboveBar" | "belowBar" | "inBar";
export type MarkerShape = "circle" | "square" | "arrowUp" | "arrowDown";

export interface MarkerDescriptor {
  /** epoch seconds (UTC) — lightweight-charts time axis. */
  time: number;
  position: MarkerPosition;
  shape: MarkerShape;
  color: string;
  text: string;
}

const TIER_COLOR: Record<Tier, string> = {
  CRITICAL: "#f85149",
  HIGH: "#e3b341",
  MEDIUM: "#58a6ff",
};

const NEUTRAL_MARKER = "#8b949e";

/**
 * Map a contract message to a discrete chart marker, or null if the family
 * does not warrant a marker (price_tick, heartbeat, snapshot, zone_update,
 * vol_regime, or any unknown family).
 */
export function messageToMarker(msg: RealtimeMessage): MarkerDescriptor | null {
  const p = msg.payload;
  const time = Math.floor(msg.ts_ns / 1e9);
  const tierColor = msg.tier ? TIER_COLOR[msg.tier] : NEUTRAL_MARKER;

  if (isSignal(p)) {
    return {
      time,
      position: "aboveBar",
      shape: "circle",
      color: tierColor,
      text: p.event_type,
    };
  }
  if (isSweep(p)) {
    return {
      time,
      position: p.direction === "up" ? "belowBar" : "aboveBar",
      shape: p.direction === "up" ? "arrowUp" : "arrowDown",
      color: tierColor,
      text: `sweep ${p.ticks_cleared}t`,
    };
  }
  if (isIceberg(p)) {
    return {
      time,
      position: p.side === "bid" ? "belowBar" : "aboveBar",
      shape: "square",
      color: tierColor,
      text: `iceberg x${p.refills}`,
    };
  }
  if (isAbsorption(p)) {
    return {
      time,
      position: p.side === "bid" ? "belowBar" : "aboveBar",
      shape: "circle",
      color: tierColor,
      text: `absorb ${p.score.toFixed(2)}`,
    };
  }
  return null;
}

// --- Live-feed item mapping ------------------------------------------------

export interface FeedItem {
  seq: number;
  tsNs: number;
  tier: Tier | null;
  family: string;
  /** Human-readable headline for the feed row. */
  text: string;
  /** Relative ordering strength 0..1 for recency+strength sort. */
  strength: number;
}

const TIER_STRENGTH: Record<Tier, number> = {
  CRITICAL: 1,
  HIGH: 0.66,
  MEDIUM: 0.33,
};

function payloadText(p: RealtimePayload): string {
  if (isSignal(p)) return p.description || p.event_type;
  if (isSweep(p)) return p.description || `Sweep ${p.direction} ${p.ticks_cleared}t`;
  if (isIceberg(p)) return p.description || `Iceberg ${p.side} x${p.refills}`;
  if (isAbsorption(p))
    return p.description || `Absorption ${p.side} ${p.score.toFixed(2)}`;
  if (isVolRegime(p)) return p.description || `Regime ${p.regime}`;
  // Unknown / generic family — render the family name, never crash.
  const desc = (p as Record<string, unknown>).description;
  return typeof desc === "string" && desc ? desc : p.family;
}

/** True for families that belong in the rolling event feed (Tier 3). */
export function isFeedFamily(family: string): boolean {
  return (
    family === "signal" ||
    family === "sweep" ||
    family === "iceberg" ||
    family === "absorption" ||
    family === "vol_regime"
  );
}

export function messageToFeedItem(msg: RealtimeMessage): FeedItem {
  return {
    seq: msg.seq,
    tsNs: msg.ts_ns,
    tier: msg.tier,
    family: msg.payload.family,
    text: payloadText(msg.payload),
    strength: msg.tier ? TIER_STRENGTH[msg.tier] : 0.15,
  };
}

/**
 * Recency + strength ordering for the live feed. Higher tier wins; ties break
 * by recency (newer first). Pure + stable for testing.
 */
export function sortFeed(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    return b.tsNs - a.tsNs;
  });
}

/**
 * Time-decay opacity for a feed row given its age in ms. Full opacity for the
 * first 5s, linearly fading to a 0.35 floor by 60s. Presentation only.
 */
export function feedOpacity(ageMs: number): number {
  const FULL_MS = 5_000;
  const FADE_MS = 60_000;
  const FLOOR = 0.35;
  if (ageMs <= FULL_MS) return 1;
  if (ageMs >= FADE_MS) return FLOOR;
  const t = (ageMs - FULL_MS) / (FADE_MS - FULL_MS);
  return 1 - t * (1 - FLOOR);
}
