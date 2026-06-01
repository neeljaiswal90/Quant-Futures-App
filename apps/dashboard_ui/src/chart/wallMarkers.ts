/**
 * RA-107a: top-N persistent-liquidity wall markers.
 *
 * Reads the DepthPersistenceAccumulator state (price -> lot-frame score),
 * picks the top N by score above a noise floor, and emits one
 * lightweight-charts price line per wall. Uses createPriceLine (existing
 * layout-only API) so this is NOT a custom primitive — avoids the autoscale
 * re-entrancy class entirely.
 *
 * Side polarization matches the heatmap (pink for ask, sky for bid).
 * Lines render dashed (LineStyle.Dashed) to distinguish from RA-105 solid
 * structural-zone lines.
 */
import {
  LineStyle,
  type IPriceLine,
  type ISeriesApi,
} from "lightweight-charts";
import { formatMnqPrice } from "../contract/render";
import { sideFromMid, type DepthSide } from "./depthHeatmap";

/** Number of walls rendered by default. Operator can reduce/increase later. */
export const DEFAULT_TOP_N_WALLS = 3;

/**
 * Persistence-score noise floor. Below this, even a top-N level isn't a real
 * wall — it's just the loudest in a quiet book. Avoids cluttering the chart
 * with low-score markers during session warm-up.
 */
export const WALL_MIN_PERSISTENCE = 100;

/** Hue families match the heatmap polarization (RA-107a). */
const WALL_ASK_COLOR = "rgba(248, 113, 113, 0.85)";
const WALL_BID_COLOR = "rgba(56, 189, 248, 0.85)";

export interface WallMarker {
  price: number;
  score: number;
  side: DepthSide;
}

export interface WallMarkerManagerOptions {
  topN?: number;
  minPersistence?: number;
}

/**
 * Compute the top-N walls from a persistence-score map + current mid.
 * Exported for unit testing; production path uses WallMarkerManager.
 */
export function selectTopWalls(
  scores: ReadonlyMap<number, number>,
  mid: number | null,
  topN: number = DEFAULT_TOP_N_WALLS,
  minPersistence: number = WALL_MIN_PERSISTENCE,
): WallMarker[] {
  const candidates: WallMarker[] = [];
  for (const [price, score] of scores) {
    if (!Number.isFinite(score) || score < minPersistence) continue;
    candidates.push({ price, score, side: sideFromMid(price, mid) });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, Math.max(0, topN));
}

export function wallMarkerTitle(wall: WallMarker): string {
  return `wall ${wall.side} ${formatMnqPrice(wall.price)} (p${Math.round(wall.score)})`;
}

export function wallMarkerColor(side: DepthSide): string {
  return side === "ask" ? WALL_ASK_COLOR : WALL_BID_COLOR;
}

/**
 * Diff-based wall-line manager. Maintains a Map of {price -> IPriceLine}, and
 * on each `update()` adds/removes/refreshes price lines to match the current
 * top-N selection. Per-frame work is O(topN) — cheap.
 */
export class WallMarkerManager {
  private readonly series: ISeriesApi<"Line">;
  private readonly topN: number;
  private readonly minPersistence: number;
  private readonly active = new Map<number, IPriceLine>();

  constructor(
    series: ISeriesApi<"Line">,
    options: WallMarkerManagerOptions = {},
  ) {
    this.series = series;
    this.topN = Math.max(0, options.topN ?? DEFAULT_TOP_N_WALLS);
    this.minPersistence = Math.max(0, options.minPersistence ?? WALL_MIN_PERSISTENCE);
  }

  update(
    scores: ReadonlyMap<number, number>,
    mid: number | null,
  ): readonly WallMarker[] {
    const top = selectTopWalls(scores, mid, this.topN, this.minPersistence);
    const topByPrice = new Map(top.map((wall) => [wall.price, wall] as const));

    // Remove price lines that dropped out of top-N
    for (const [price, line] of this.active) {
      if (!topByPrice.has(price)) {
        this.series.removePriceLine(line);
        this.active.delete(price);
      }
    }
    // Add or refresh
    for (const wall of top) {
      const existing = this.active.get(wall.price);
      if (existing) {
        existing.applyOptions({
          title: wallMarkerTitle(wall),
          color: wallMarkerColor(wall.side),
        });
      } else {
        const line = this.series.createPriceLine({
          price: wall.price,
          color: wallMarkerColor(wall.side),
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: wallMarkerTitle(wall),
        });
        this.active.set(wall.price, line);
      }
    }
    return top;
  }

  clear(): void {
    for (const line of this.active.values()) {
      this.series.removePriceLine(line);
    }
    this.active.clear();
  }

  /** Test-only accessor — count of currently-rendered walls. */
  activeCount(): number {
    return this.active.size;
  }
}
