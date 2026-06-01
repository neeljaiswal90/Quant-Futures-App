import type { DepthPayload, ZoneState } from "@contracts/realtime/events";
import type { FeedItem } from "../contract/render";
import { clampDepthNTicks } from "../chart/depthLimits";
import { priceToTickKey, tickKeyToPrice } from "../chart/priceGrid";

export const DOM_LADDER_VISIBLE_RADIUS_TICKS = 18;
export const DOM_LADDER_MARGIN_TICKS = 1;
export const DOM_LADDER_WHEEL_TICKS = 4;
export const ICEBERG_FADE_MS = 10 * 60 * 1000;

export interface DomLadderRow {
  price: number;
  bidSize: number;
  askSize: number;
  bidPct: number;
  askPct: number;
  isLastPrice: boolean;
  isLiveRestingPrice: boolean;
  zoneLabels: string[];
  icebergOpacity: number;
}

interface IcebergMarker {
  key: number;
  opacity: number;
  dedupeKey: string;
}

function priceKey(price: number): number {
  return priceToTickKey(price);
}

function keyToPrice(key: number): number {
  return tickKeyToPrice(key);
}

export function domLadderRadiusTicks(depth: DepthPayload): number {
  return Math.min(clampDepthNTicks(depth.n_ticks), DOM_LADDER_VISIBLE_RADIUS_TICKS) +
    DOM_LADDER_MARGIN_TICKS;
}

export function domLadderWheelShift(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  return deltaY < 0 ? DOM_LADDER_WHEEL_TICKS : -DOM_LADDER_WHEEL_TICKS;
}

export function shouldRecenterDomLadder(
  centerPrice: number | null,
  activePrice: number | null,
  nTicks: number,
): boolean {
  if (activePrice == null || !Number.isFinite(activePrice)) return false;
  if (centerPrice == null || !Number.isFinite(centerPrice)) return true;
  const visibleTicks = Math.min(clampDepthNTicks(nTicks), DOM_LADDER_VISIBLE_RADIUS_TICKS);
  const radius = visibleTicks + DOM_LADDER_MARGIN_TICKS;
  const hysteresisTicks = Math.max(1, Math.round(visibleTicks * 0.35));
  const thresholdTicks = Math.max(1, radius - hysteresisTicks);
  return Math.abs(priceKey(activePrice) - priceKey(centerPrice)) > thresholdTicks;
}

function sizeMap(levels: DepthPayload["bid_levels"]): Map<number, number> {
  const out = new Map<number, number>();
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size)) continue;
    const key = priceKey(level.price);
    out.set(key, (out.get(key) ?? 0) + level.size);
  }
  return out;
}

function zoneLabelsByKey(zones: readonly ZoneState[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const zone of zones) {
    const key = priceKey(zone.price);
    const labels = out.get(key) ?? [];
    labels.push(zone.label ?? zone.kind.toUpperCase());
    out.set(key, labels);
  }
  return out;
}

function icebergMarkersByKey(
  history: readonly FeedItem[],
  zones: readonly ZoneState[],
  nowMs: number,
): Map<number, IcebergMarker> {
  const zoneKeyById = new Map<string, number>();
  for (const zone of zones) zoneKeyById.set(zone.id, priceKey(zone.price));

  const markers = new Map<number, IcebergMarker>();
  const seen = new Set<string>();
  for (const item of history) {
    if (item.family !== "iceberg") continue;
    const ageMs = nowMs - Math.floor(item.tsNs / 1e6);
    if (ageMs < 0 || ageMs > ICEBERG_FADE_MS) continue;
    const key =
      item.levelId != null && zoneKeyById.has(item.levelId)
        ? zoneKeyById.get(item.levelId)
        : item.price != null
          ? priceKey(item.price)
          : undefined;
    if (key == null) continue;
    const dedupeKey = [
      item.family,
      item.levelId ?? key,
      item.side ?? "",
      item.tier ?? "",
    ].join("|");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const opacity = Math.max(0.18, 1 - ageMs / ICEBERG_FADE_MS);
    const previous = markers.get(key);
    if (previous == null || opacity > previous.opacity) {
      markers.set(key, { key, opacity, dedupeKey });
    }
  }
  return markers;
}

export interface BuildDomLadderRowsArgs {
  depth: DepthPayload;
  centerPrice: number;
  lastPrice: number | null;
  zones: readonly ZoneState[];
  history: readonly FeedItem[];
  nowMs: number;
}

export function buildDomLadderRows({
  depth,
  centerPrice,
  lastPrice,
  zones,
  history,
  nowMs,
}: BuildDomLadderRowsArgs): DomLadderRow[] {
  if (depth.quality === "unavailable") return [];
  const radius = domLadderRadiusTicks(depth);
  const centerKey = priceKey(centerPrice);
  const lastPriceKey =
    lastPrice != null && Number.isFinite(lastPrice) ? priceKey(lastPrice) : null;
  const bids = sizeMap(depth.bid_levels);
  const asks = sizeMap(depth.ask_levels);
  const zonesByKey = zoneLabelsByKey(zones);
  const icebergsByKey = icebergMarkersByKey(history, zones, nowMs);

  let maxSize = 1;
  for (let key = centerKey - radius; key <= centerKey + radius; key += 1) {
    maxSize = Math.max(maxSize, bids.get(key) ?? 0, asks.get(key) ?? 0);
  }

  const rows: DomLadderRow[] = [];
  for (let key = centerKey + radius; key >= centerKey - radius; key -= 1) {
    const bidSize = bids.get(key) ?? 0;
    const askSize = asks.get(key) ?? 0;
    const isLastPrice = lastPriceKey === key;
    rows.push({
      price: keyToPrice(key),
      bidSize,
      askSize,
      bidPct: bidSize / maxSize,
      askPct: askSize / maxSize,
      isLastPrice,
      isLiveRestingPrice: isLastPrice && (bidSize > 0 || askSize > 0),
      zoneLabels: zonesByKey.get(key) ?? [],
      icebergOpacity: icebergsByKey.get(key)?.opacity ?? 0,
    });
  }
  return rows;
}
