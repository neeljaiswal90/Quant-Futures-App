/**
 * RA-108: chart anchor renderer for session-long persistent levels.
 *
 * Reads the `state.persistentLevels` map (keyed by level_id) and maintains
 * one lightweight-charts price line per active level. Uses createPriceLine
 * (layout-only) NOT a custom primitive — matches the RA-107a wall-markers
 * pattern and avoids the autoscale re-entrancy class entirely.
 *
 * Visual taxonomy (matches the RA-107a / RA-107b palette carve-out):
 *
 *   side  ── pink-400 for ask (ceiling), sky-400 for bid (floor)
 *   confidence ── line style:
 *       high      → Solid       (full alpha, primary attention)
 *       medium    → Dotted      (70% alpha)
 *       low       → LargeDashed  (50% alpha)
 *   status modulates alpha:
 *       active        → 1.0
 *       deteriorating → 0.45 (operator sees the fade)
 *       broken        → not rendered (line removed)
 *
 * RA-107a wall markers (short-window dominant levels, top-3 only) use
 * Dashed style; RA-108 lines use Solid/Dotted/LargeDashed so the
 * operator can distinguish a short-window wall from a session-long
 * structural level at a glance.
 */
import {
  LineStyle,
  type IPriceLine,
  type ISeriesApi,
} from "lightweight-charts";
import type { PersistentLevelPayload } from "@contracts/realtime/events";
import { formatMnqPrice } from "../contract/render";

/** Max simultaneous lines rendered. Excess clipped to nearest-to-mid. */
export const DEFAULT_MAX_RENDERED_LEVELS = 12;

const ASK_COLOR_ACTIVE = "rgba(248, 113, 113, 0.95)"; // pink-400
const ASK_COLOR_DETERIORATING = "rgba(248, 113, 113, 0.45)";
const BID_COLOR_ACTIVE = "rgba(56, 189, 248, 0.95)"; // sky-400
const BID_COLOR_DETERIORATING = "rgba(56, 189, 248, 0.45)";
const UNKNOWN_COLOR_ACTIVE = "rgba(203, 213, 225, 0.85)"; // slate fallback
const UNKNOWN_COLOR_DETERIORATING = "rgba(203, 213, 225, 0.40)";

export interface PersistentLevelManagerOptions {
  maxRenderedLevels?: number;
}

interface ActiveEntry {
  line: IPriceLine;
  signature: string;  // for cheap dirty-checking on update
}

function lineStyleForConfidence(
  confidence: PersistentLevelPayload["confidence"],
): LineStyle {
  if (confidence === "high") return LineStyle.Solid;
  if (confidence === "medium") return LineStyle.Dotted;
  return LineStyle.LargeDashed;
}

function colorFor(
  side: PersistentLevelPayload["side"],
  status: PersistentLevelPayload["status"],
): string {
  const deteriorating = status === "deteriorating";
  if (side === "ask") return deteriorating ? ASK_COLOR_DETERIORATING : ASK_COLOR_ACTIVE;
  if (side === "bid") return deteriorating ? BID_COLOR_DETERIORATING : BID_COLOR_ACTIVE;
  return deteriorating ? UNKNOWN_COLOR_DETERIORATING : UNKNOWN_COLOR_ACTIVE;
}

export function persistentLevelTitle(level: PersistentLevelPayload): string {
  // < 60s reads in seconds; >= 60s reads in rounded minutes. Avoids the
  // "30s -> 1m" rounding edge case that loses operator-meaningful precision.
  const persistText =
    level.persistence_seconds >= 60
      ? `${Math.round(level.persistence_seconds / 60)}m`
      : `${Math.round(level.persistence_seconds)}s`;
  return `LVL ${level.side} ${formatMnqPrice(level.price)} ${level.confidence} (${persistText})`;
}

function entrySignature(level: PersistentLevelPayload): string {
  // Lines re-style when any of these change. price + confidence + status +
  // side are the visible properties; persistence_seconds rolling forward
  // updates the title text via the entry refresh path.
  return [
    level.price.toFixed(4),
    level.side,
    level.confidence,
    level.status,
    Math.round(level.persistence_seconds),
  ].join("|");
}

/**
 * Selects which levels to render given a viewport-anchor and the max-cap.
 * "broken" status is excluded entirely; others sort by absolute distance
 * from the anchor (typically current mid) and the top-K nearest are kept.
 * Exported for unit testing.
 */
export function selectRenderableLevels(
  levels: Iterable<PersistentLevelPayload>,
  anchorPrice: number | null,
  cap: number,
): PersistentLevelPayload[] {
  const eligible: PersistentLevelPayload[] = [];
  for (const level of levels) {
    if (level.status === "broken") continue;
    eligible.push(level);
  }
  if (anchorPrice != null && Number.isFinite(anchorPrice)) {
    eligible.sort(
      (a, b) =>
        Math.abs(a.price - anchorPrice) - Math.abs(b.price - anchorPrice),
    );
  } else {
    eligible.sort((a, b) => a.price - b.price);
  }
  return eligible.slice(0, Math.max(0, cap));
}

/**
 * Diff-based renderer for persistent-level price lines. Maintains a map
 * of {level_id -> IPriceLine}, applies adds/updates/removes on each call
 * to update(). Cost per frame is O(K) where K = active levels (capped).
 */
export class PersistentLevelManager {
  private readonly series: ISeriesApi<"Line">;
  private readonly maxRenderedLevels: number;
  private readonly active = new Map<string, ActiveEntry>();

  constructor(
    series: ISeriesApi<"Line">,
    options: PersistentLevelManagerOptions = {},
  ) {
    this.series = series;
    this.maxRenderedLevels = Math.max(
      0,
      options.maxRenderedLevels ?? DEFAULT_MAX_RENDERED_LEVELS,
    );
  }

  update(
    levelsById: Readonly<Record<string, PersistentLevelPayload>>,
    anchorPrice: number | null,
  ): readonly PersistentLevelPayload[] {
    const rendered = selectRenderableLevels(
      Object.values(levelsById),
      anchorPrice,
      this.maxRenderedLevels,
    );
    const renderedIds = new Set(rendered.map((level) => level.level_id));

    // Remove lines whose level_id dropped out (either too far from anchor,
    // or status became broken, or level was deleted from the store).
    for (const [level_id, entry] of this.active) {
      if (!renderedIds.has(level_id)) {
        this.series.removePriceLine(entry.line);
        this.active.delete(level_id);
      }
    }

    // Add or refresh.
    for (const level of rendered) {
      const signature = entrySignature(level);
      const existing = this.active.get(level.level_id);
      if (existing != null) {
        if (existing.signature === signature) continue;
        existing.line.applyOptions({
          price: level.price,
          color: colorFor(level.side, level.status),
          lineStyle: lineStyleForConfidence(level.confidence),
          title: persistentLevelTitle(level),
        });
        existing.signature = signature;
        continue;
      }
      const line = this.series.createPriceLine({
        price: level.price,
        color: colorFor(level.side, level.status),
        lineWidth: 1,
        lineStyle: lineStyleForConfidence(level.confidence),
        axisLabelVisible: false,
        title: persistentLevelTitle(level),
      });
      this.active.set(level.level_id, { line, signature });
    }

    return rendered;
  }

  clear(): void {
    for (const entry of this.active.values()) {
      this.series.removePriceLine(entry.line);
    }
    this.active.clear();
  }

  /** Test-only accessor — count of currently-rendered lines. */
  activeCount(): number {
    return this.active.size;
  }
}
