import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  AutoscaleInfo,
  Coordinate,
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { DepthPayload, DepthQuality } from "@contracts/realtime/events";
import { MNQ_TICK, formatMnqPrice } from "../contract/render";
import { DEPTH_N_TICKS_HARD_CAP } from "./depthLimits";
import {
  DepthPersistenceAccumulator,
  rawLevelMap,
  type DepthPersistenceInputLevel,
} from "./depthPersistence";
import { snapPrice } from "./priceGrid";

export const DEPTH_HISTORY_WINDOW_SECONDS = 8 * 60 * 60;
export const MAX_DEPTH_COLUMNS = 12_000;
export const MAX_VISIBLE_DEPTH_COLUMNS = 420;
/**
 * Per-projection cell budget. RA-104b raised the depth window to n_ticks=200,
 * which pushed columns to a ~277-level median — so the old 32k budget was
 * exhausted only ~3 minutes into a 14-minute window, and because the loop ran
 * oldest→newest it dropped the NEWEST columns (the live right edge went dark
 * while old data rendered). RA-112b raises the budget AND makes two structural
 * fixes that keep it affordable: (1) the projection iterates newest→oldest so
 * the budget always protects the live edge, and (2) levels outside the visible
 * price band are culled before they consume the budget. With vertical culling
 * a typical window draws far fewer than this; the cap only bites when the user
 * zooms out to the full ±50pt depth band, in which case the oldest (leftmost)
 * columns are the ones trimmed.
 */
export const MAX_DEPTH_CELLS = 75_000;
export const MIN_DEPTH_CELL_WIDTH = 1.5;
/**
 * RA-108-bug-fix: cap a single depth cell's time width. Without this cap, a
 * column whose next-column-timestamp is far in the future (capture/backend
 * restart, network reconnect, session boundary) renders as a horizontal
 * block spanning minutes — both visually wrong AND a perf hit since giant
 * filled rectangles burn fillRect cost. 30s is a generous upper bound on
 * legitimate inter-column gaps at 4 fps emission with debouncing.
 */
export const MAX_DEPTH_CELL_DURATION_SECONDS = 30;
/** RA-111: depth-payload count per chunk during cold backfill replay. */
export const HYDRATION_DEPTH_CHUNK_SIZE = 200;
export const DEPTH_CONTRAST_WINDOW_SECONDS = 10 * 60;
/**
 * RA-112d: floor percentile — liquidity at/below this drops to fully dark.
 * Raised 0.25 → 0.35 so the bottom third of the book (thin noise) recedes to
 * black, leaving the heatmap bimodal: dark background, isolated bright walls.
 */
export const DEPTH_CONTRAST_PERCENTILE = 0.35;
/**
 * RA-112c: the heatmap's "bright point". Liquidity at/above this percentile of
 * the rolling window saturates to full intensity. Using a robust high
 * percentile instead of the absolute max stops a single long-standing mega-wall
 * (steady-state persistence can be 10-20x a normal level) from compressing the
 * whole book into one dim/medium band — which is what made the heatmap read as
 * "all the same shade". With p95 the top ~5% of levels render as bright walls.
 */
export const DEPTH_CONTRAST_BRIGHT_PERCENTILE = 0.95;
export const DEPTH_CONTRAST_MIN_SCORE = 5.0;
/**
 * RA-112c/d: intensity transfer exponent. 0.5 (sqrt) lifted mid-range up so
 * everything looked equally bright; 1.0 gave an honest spread. 2.0 makes it
 * BIMODAL — mid/thin liquidity is pushed down toward dark and only genuine
 * walls (top of the p95-normalized range) glow, so individual strong levels
 * read as isolated bright lines instead of a continuous wash. Lower toward 1.0
 * to light up more of the book; raise to isolate walls further.
 */
export const DEPTH_INTENSITY_POWER = 2.0;
/**
 * RA-112c: widened the opacity range so contrast reads on a dark background.
 * Thin liquidity is now near-invisible (0.06) and walls are fully opaque (1.0),
 * vs the old 0.15..0.95 band where everything sat in a muddy middle.
 */
export const DEPTH_MIN_SHOWN_OPACITY = 0.06;
export const DEPTH_MAX_OPACITY = 1.0;
export const DEPTH_HEATMAP_ID_PREFIX = "depth-heatmap:";
/**
 * RA-112 (Tier 1 perf): number of intensity buckets used to QUANTIZE the
 * per-cell fill color. The continuous intensity → rgba() mapping otherwise
 * produces a near-unique color string per cell, which defeats the batched
 * draw path (one fillStyle + one fill() per distinct color). Snapping color
 * intensity to 24 buckets collapses thousands of cells into <=48 color groups
 * (24 buckets x 2 sides) so the draw loop issues <=48 fill() calls instead of
 * one fillRect()+save()+restore() per cell. The cell still carries its TRUE
 * intensity for hit-testing; only the COLOR is quantized — visually
 * indistinguishable at 24 alpha/hue steps.
 */
export const DEPTH_COLOR_INTENSITY_BUCKETS = 24;

export type DepthSide = "bid" | "ask";

export interface DepthHistoryLevel {
  price: number;
  /** Decay-weighted persistence score in lot-frames, not raw lots. */
  size: number;
  /** Current raw resting size for this price in the source depth frame. */
  rawSize: number;
  /**
   * Side polarity derived from `price` vs the column's `mid`. RA-107a uses
   * side to pick the heatmap-cell hue family (pink for ask, sky for bid).
   * If the source payload's mid is null at the time the column was built,
   * defaults to "ask" as the documented tie-break.
   */
  side: DepthSide;
}

export interface DepthHistoryColumn {
  tsNs: number;
  seconds: number;
  mid: number | null;
  quality: DepthQuality;
  levels: DepthHistoryLevel[];
}

export interface DepthHeatmapCell extends DepthHistoryLevel {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  intensity: number;
  fillColor: string;
  quality: DepthQuality;
}

export interface HoveredDepthCell {
  item: DepthHeatmapCell;
  point: { x: number; y: number };
}

export interface VisibleTimeRangeSeconds {
  from: number;
  to: number;
}

export interface DepthContrastStats {
  rollingMaxSize: number;
  floorSize: number;
}

type CoordinateFn<T> = (value: T) => Coordinate | number | null;

function rawDepthLevels(payload: DepthPayload): DepthPersistenceInputLevel[] {
  return [
    ...payload.bid_levels.slice(0, DEPTH_N_TICKS_HARD_CAP),
    ...payload.ask_levels.slice(0, DEPTH_N_TICKS_HARD_CAP),
  ]
    .filter((level) => (
      Number.isFinite(level.price) &&
      Number.isFinite(level.size) &&
      level.size > 0
    ))
    .map((level) => ({ price: snapPrice(level.price), size: level.size }));
}

export function depthPayloadToColumn(
  payload: DepthPayload,
  accumulator = new DepthPersistenceAccumulator(),
): DepthHistoryColumn | null {
  if (
    payload.quality === "unavailable" ||
    payload.bid_levels.length + payload.ask_levels.length === 0
  ) {
    return null;
  }

  const rawLevels = rawDepthLevels(payload);
  if (rawLevels.length === 0) return null;

  const rawByPrice = rawLevelMap(rawLevels);
  const persistence = accumulator.update(rawLevels, payload.ts_ns);
  const mid = payload.mid;
  const levels: DepthHistoryLevel[] = [];
  for (const [price, size] of persistence) {
    levels.push({
      price,
      size,
      rawSize: rawByPrice.get(price) ?? 0,
      side: sideFromMid(price, mid),
    });
  }
  levels.sort((a, b) => a.price - b.price);

  return {
    tsNs: payload.ts_ns,
    seconds: payload.ts_ns / 1e9,
    mid: payload.mid,
    quality: payload.quality,
    levels,
  };
}

export function maxDepthSize(columns: readonly DepthHistoryColumn[]): number {
  let max = 0;
  for (const column of columns) {
    for (const level of column.levels) {
      if (level.size > max) max = level.size;
    }
  }
  return max;
}

export function coordinateForEpochSeconds(
  seconds: number,
  timeToCoordinate: CoordinateFn<UTCTimestamp>,
): number | null {
  if (!Number.isFinite(seconds)) return null;
  const whole = Math.floor(seconds);
  const fraction = seconds - whole;
  const x0 = timeToCoordinate(whole as UTCTimestamp);
  if (x0 == null) return null;
  if (fraction <= 0) return Number(x0);

  const x1 = timeToCoordinate((whole + 1) as UTCTimestamp);
  if (x1 == null) return Number(x0);
  return Number(x0) + (Number(x1) - Number(x0)) * fraction;
}

export function timeValueSeconds(time: Time): number | null {
  if (typeof time === "number") return time;
  if (typeof time === "string") {
    const parsed = Date.parse(`${time}T00:00:00Z`);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  const parsed = Date.UTC(time.year, time.month - 1, time.day) / 1000;
  return Number.isFinite(parsed) ? parsed : null;
}

export function visibleTimeRangeSeconds(
  range: { from: Time; to: Time } | null,
): VisibleTimeRangeSeconds | null {
  if (range == null) return null;
  const from = timeValueSeconds(range.from);
  const to = timeValueSeconds(range.to);
  if (from == null || to == null) return null;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) return 0;
  // RA-112c: round (not floor) the rank so high percentiles on small samples
  // resolve toward the top value instead of collapsing to a low one — e.g.
  // p95 of a 2-element sample picks the larger, not the smaller.
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.round((values.length - 1) * pct)),
  );
  return values[index] ?? 0;
}

export function depthContrastStats(
  columns: readonly DepthHistoryColumn[],
  nowSeconds: number,
  windowSeconds = DEPTH_CONTRAST_WINDOW_SECONDS,
): DepthContrastStats {
  const cutoffSeconds = nowSeconds - windowSeconds;
  const sizes: number[] = [];

  for (const column of columns) {
    if (column.seconds < cutoffSeconds || column.seconds > nowSeconds) continue;
    for (const level of column.levels) {
      if (!Number.isFinite(level.size) || level.size <= 0) continue;
      sizes.push(level.size);
    }
  }

  if (sizes.length === 0) {
    return { rollingMaxSize: 0, floorSize: 0 };
  }

  sizes.sort((a, b) => a - b);
  const p25 = percentile(sizes, DEPTH_CONTRAST_PERCENTILE);
  // RA-112c: normalize against a robust high percentile ("bright point") rather
  // than the absolute max, so one persistent mega-wall doesn't flatten the rest
  // of the book. Levels at/above this saturate (depthIntensity clamps to 1).
  const bright = percentile(sizes, DEPTH_CONTRAST_BRIGHT_PERCENTILE);
  return {
    rollingMaxSize: bright,
    floorSize: Math.max(p25, DEPTH_CONTRAST_MIN_SCORE),
  };
}

export function depthIntensity(
  size: number,
  rollingMaxSize: number,
  floorSize = 0,
): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  if (!Number.isFinite(rollingMaxSize) || rollingMaxSize <= 0) return 0;
  if (size <= floorSize) return 0;
  if (rollingMaxSize <= floorSize) return 1;
  const scaled = ((size - floorSize) / (rollingMaxSize - floorSize)) ** DEPTH_INTENSITY_POWER;
  return Math.max(0, Math.min(1, scaled));
}

export function depthCellOpacity(intensity: number, quality: DepthQuality): number {
  const clamped = Math.max(0, Math.min(1, intensity));
  if (clamped <= 0) return 0;
  const base =
    DEPTH_MIN_SHOWN_OPACITY + clamped * (DEPTH_MAX_OPACITY - DEPTH_MIN_SHOWN_OPACITY);
  if (quality === "stale_l1") return base * 0.35;
  if (quality === "inferred") return base * 0.72;
  return quality === "live" ? base : 0;
}

/**
 * RA-107a: derive bid/ask side from a level's price vs the column's mid.
 * Tie-break (price === mid OR mid == null) defaults to "ask" so the heatmap
 * is deterministic on cold start when the backend hasn't published a mid yet.
 */
export function sideFromMid(price: number, mid: number | null): DepthSide {
  if (mid == null || !Number.isFinite(mid)) return "ask";
  return price < mid ? "bid" : "ask";
}

/**
 * RA-112 (Tier 1 perf): snap a continuous intensity to one of
 * DEPTH_COLOR_INTENSITY_BUCKETS steps so many cells resolve to the SAME
 * rgba() string and the batched renderer can group them. Pure function;
 * the cell retains its unrounded intensity elsewhere for hit-testing.
 */
export function quantizeIntensityForColor(intensity: number): number {
  const t = Math.max(0, Math.min(1, intensity));
  return Math.round(t * DEPTH_COLOR_INTENSITY_BUCKETS) / DEPTH_COLOR_INTENSITY_BUCKETS;
}

/**
 * RA-107a/RA-112c: side-polarized, intensity-graded liquidity palette.
 *
 *   Ask side (sellers): dark maroon → red → HOT ORANGE  (255, 200, 135) at peak.
 *   Bid side (buyers):  dark navy  → sky → BRIGHT CYAN   (190, 240, 255) at peak.
 *
 * RA-112c makes walls POP: intensity now drives BOTH opacity (depthCellOpacity,
 * 0.06→1.0) AND a hue/brightness ramp toward a hot top, so a large resting size
 * glows against faint thin liquidity. The g/b channels rise on a t**1.6 curve so
 * the brightening is concentrated in the upper range (only real walls glow).
 * Hue still encodes SIDE; the green/red execution palette stays reserved for
 * trade markers (RA-100/RA-103 carve-out).
 */
export function depthCellColor(
  intensity: number,
  quality: DepthQuality,
  side: DepthSide = "ask",
): string {
  const t = Math.max(0, Math.min(1, intensity));
  const hot = t ** 1.6; // upper-range emphasis for the glow
  const alpha = depthCellOpacity(t, quality);
  if (side === "ask") {
    // dark maroon -> red -> hot orange
    const r = Math.round(90 + 165 * t);
    const g = Math.round(25 + 175 * hot);
    const b = Math.round(25 + 110 * hot);
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
  }
  // dark navy -> sky -> bright cyan-white
  const r = Math.round(15 + 175 * hot);
  const g = Math.round(50 + 190 * t);
  const b = Math.round(90 + 165 * t);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

interface DepthColumnInterval {
  column: DepthHistoryColumn;
  startSeconds: number;
  endSeconds: number;
}

function overlapsVisibleRange(
  startSeconds: number,
  endSeconds: number,
  visibleRange: VisibleTimeRangeSeconds | null,
): boolean {
  if (visibleRange == null) return true;
  return endSeconds >= visibleRange.from && startSeconds <= visibleRange.to;
}

function sampledVisibleIntervals(
  columns: readonly DepthHistoryColumn[],
  nowSeconds: number,
  visibleRange: VisibleTimeRangeSeconds | null,
  maxColumns: number,
): DepthColumnInterval[] {
  const intervals: DepthColumnInterval[] = [];
  for (let i = 0; i < columns.length; i += 1) {
    const startSeconds = columns[i].seconds;
    const nextSeconds = columns[i + 1]?.seconds ?? nowSeconds;
    // RA-108-bug-fix: clamp the cell's time-end to startSeconds +
    // MAX_DEPTH_CELL_DURATION_SECONDS. Without this, a depth column followed
    // by a long capture/backend gap renders as a horizontal block stretching
    // across the gap. The MIN side keeps the existing 0.25s minimum so
    // tightly-spaced columns still get visible cells.
    const rawEnd = Math.max(startSeconds + 0.25, nextSeconds);
    const endSeconds = Math.min(
      rawEnd,
      startSeconds + MAX_DEPTH_CELL_DURATION_SECONDS,
    );
    if (overlapsVisibleRange(startSeconds, endSeconds, visibleRange)) {
      intervals.push({ column: columns[i], startSeconds, endSeconds });
    }
  }
  if (intervals.length <= maxColumns) return intervals;
  const stride = Math.ceil(intervals.length / maxColumns);
  return intervals.filter((_, index) => index % stride === 0);
}

function cellBandHeight(
  price: number,
  priceToCoordinate: CoordinateFn<number>,
  tickSize: number,
): { y: number; height: number } | null {
  const center = priceToCoordinate(price);
  if (center == null) return null;
  const upper = priceToCoordinate(price + tickSize / 2);
  const lower = priceToCoordinate(price - tickSize / 2);
  let height = 2;
  if (upper != null && lower != null) {
    height = Math.abs(Number(lower) - Number(upper));
  }
  height = Math.max(1.5, Math.min(12, height));
  return { y: Number(center) - height / 2, height };
}

export interface VisiblePriceRange {
  min: number;
  max: number;
}

export interface ProjectDepthOptions {
  nowSeconds: number;
  visibleRange?: VisibleTimeRangeSeconds | null;
  sessionMaxSize?: number;
  floorSize?: number;
  contrastStats?: DepthContrastStats;
  contrastWindowSeconds?: number;
  maxVisibleColumns?: number;
  maxCells?: number;
  tickSize?: number;
  /**
   * RA-112b: visible price band (price units, margin already applied by the
   * caller). Levels outside it are skipped BEFORE consuming the cell budget,
   * so off-screen depth doesn't starve the on-screen live edge. Null/omitted
   * disables vertical culling (renders every level; back-compat for tests).
   */
  visiblePriceRange?: VisiblePriceRange | null;
}

export function projectDepthHeatmapCells(
  columns: readonly DepthHistoryColumn[],
  timeToCoordinate: CoordinateFn<UTCTimestamp>,
  priceToCoordinate: CoordinateFn<number>,
  options: ProjectDepthOptions,
): DepthHeatmapCell[] {
  const visibleRange = options.visibleRange ?? null;
  const priceRange = options.visiblePriceRange ?? null;
  const maxVisibleColumns = options.maxVisibleColumns ?? MAX_VISIBLE_DEPTH_COLUMNS;
  const maxCells = options.maxCells ?? MAX_DEPTH_CELLS;
  const tickSize = options.tickSize ?? MNQ_TICK;
  const contrast =
    options.contrastStats ??
    (options.sessionMaxSize != null
      ? {
          rollingMaxSize: options.sessionMaxSize,
          floorSize: options.floorSize ?? 0,
        }
      : depthContrastStats(
          columns,
          options.nowSeconds,
          options.contrastWindowSeconds,
        ));
  if (columns.length === 0 || contrast.rollingMaxSize <= 0) return [];

  const intervals = sampledVisibleIntervals(
    columns,
    options.nowSeconds,
    visibleRange,
    maxVisibleColumns,
  );

  const cells: DepthHeatmapCell[] = [];
  // RA-112b: iterate NEWEST → oldest. The cell budget (maxCells) must never
  // sacrifice the live right edge — the most recent columns are what a trader
  // watches. When the budget is exhausted we stop, which drops the OLDEST
  // (leftmost) columns. Output order is irrelevant to consumers: the renderer
  // groups by color and hit-testing scans for max intensity, both
  // order-independent.
  for (let i = intervals.length - 1; i >= 0; i -= 1) {
    if (cells.length >= maxCells) break;
    const interval = intervals[i];
    const drawStartSeconds =
      visibleRange == null
        ? interval.startSeconds
        : Math.max(interval.startSeconds, visibleRange.from);
    const drawEndSeconds =
      visibleRange == null
        ? interval.endSeconds
        : Math.min(interval.endSeconds, visibleRange.to);
    const xStart = coordinateForEpochSeconds(drawStartSeconds, timeToCoordinate);
    const xEnd = coordinateForEpochSeconds(drawEndSeconds, timeToCoordinate);
    if (xStart == null) continue;
    const rawWidth = xEnd == null ? MIN_DEPTH_CELL_WIDTH : Math.abs(xEnd - xStart);
    const width = Math.max(MIN_DEPTH_CELL_WIDTH, rawWidth);

    for (const level of interval.column.levels) {
      // RA-112b: vertical cull — skip levels outside the visible price band
      // BEFORE they consume the budget. At n_ticks=200 a column has ~277
      // levels but only a fraction are on-screen; counting the off-screen ones
      // against maxCells is what starved the live edge.
      if (
        priceRange != null &&
        (level.price < priceRange.min || level.price > priceRange.max)
      ) {
        continue;
      }
      const band = cellBandHeight(level.price, priceToCoordinate, tickSize);
      if (band == null) continue;
      const intensity = depthIntensity(
        level.size,
        contrast.rollingMaxSize,
        contrast.floorSize,
      );
      if (intensity <= 0) continue;
      cells.push({
        ...level,
        id: `${DEPTH_HEATMAP_ID_PREFIX}${interval.column.tsNs}|${level.price}`,
        x: xStart,
        y: band.y,
        width,
        height: band.height,
        intensity,
        // RA-112: quantize ONLY the color so the batched renderer groups cells;
        // `intensity` above stays continuous for hit-test priority.
        fillColor: depthCellColor(
          quantizeIntensityForColor(intensity),
          interval.column.quality,
          level.side,
        ),
        quality: interval.column.quality,
      });
      if (cells.length >= maxCells) break;
    }
  }

  return cells;
}

export function depthHeatmapTooltip(cell: Pick<DepthHeatmapCell, "price" | "size" | "rawSize">): string {
  return `${formatMnqPrice(cell.price)} | persist ${Math.round(cell.size).toLocaleString()} lot-frames | size ${Math.round(cell.rawSize).toLocaleString()} lots`;
}

class DepthHeatmapRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly cells: readonly DepthHeatmapCell[],
    private readonly backend: DepthHeatmapBackend,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    // RA-115: WebGPU overlay layer handles painting in gpu mode. The cells
    // array is still populated so hit-testing (cellAtPoint / itemById) keeps
    // working — but skipping the Canvas2D fillRect issuance is the whole
    // point of switching to GPU rendering.
    if (this.backend === "gpu") return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      // RA-112 (Tier 1 perf): batch by fill color. The previous loop did
      // save()/fillStyle=/fillRect()/restore() PER CELL — at up to
      // MAX_DEPTH_CELLS that is ~4x32k native canvas crosses per frame and is
      // the dominant cost behind the laggy heatmap. Cells now carry a
      // quantized color (<=48 distinct), so we group on-screen cells by color
      // and emit one fillStyle + one beginPath/fill() per color group. The
      // per-rect geometry (ctx.rect) is unavoidable, but a single batched
      // fill() of a multi-rect path lets the canvas backend coalesce the
      // raster pass instead of paying call overhead 32k times.
      const groups = new Map<string, DepthHeatmapCell[]>();
      for (const cell of this.cells) {
        if (cell.y > mediaSize.height + 4 || cell.y + cell.height < -4) continue;
        const bucket = groups.get(cell.fillColor);
        if (bucket === undefined) {
          groups.set(cell.fillColor, [cell]);
        } else {
          bucket.push(cell);
        }
      }
      for (const [color, cells] of groups) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const cell of cells) {
          ctx.rect(cell.x, cell.y, cell.width, cell.height);
        }
        ctx.fill();
      }
    });
  }
}

class DepthHeatmapPaneView implements IPrimitivePaneView {
  private cells: readonly DepthHeatmapCell[] = [];
  private backend: DepthHeatmapBackend = "canvas2d";

  update(cells: readonly DepthHeatmapCell[]): void {
    this.cells = cells;
  }

  setBackend(backend: DepthHeatmapBackend): void {
    this.backend = backend;
  }

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer {
    return new DepthHeatmapRenderer(this.cells, this.backend);
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const cell = this.cellAtPoint(x, y);
    if (cell == null) return null;
    return {
      externalId: cell.id,
      zOrder: "bottom",
      distance: 0,
      hitTestPriority: 0,
      cursorStyle: "crosshair",
      itemType: "marker",
    };
  }

  itemById(id: unknown): DepthHeatmapCell | null {
    if (typeof id !== "string") return null;
    return this.cells.find((cell) => cell.id === id) ?? null;
  }

  cellAtPoint(x: number, y: number): DepthHeatmapCell | null {
    let best: DepthHeatmapCell | null = null;
    for (const cell of this.cells) {
      if (
        x >= cell.x &&
        x <= cell.x + cell.width &&
        y >= cell.y &&
        y <= cell.y + cell.height &&
        (best == null || cell.intensity > best.intensity)
      ) {
        best = cell;
      }
    }
    return best;
  }
}

/**
 * Rendering backend for the depth heatmap. Default is Canvas2D (per-cell
 * batched fillRect). When set to "gpu", this primitive STOPS projecting and
 * drawing — the WebGPU overlay layer (apps/dashboard_ui/src/chart/gpu/
 * depthHeatmapLayer.ts) reads from `getColumns()` and renders to its own
 * canvas above the LC pane. The primitive remains attached so the column
 * buffer, persistence accumulator, hit-testing, and persistent-level/wall
 * markers keep working unchanged — only the visual draw path is swapped.
 *
 * RA-115 (Option D, Phase 1): default stays "canvas2d" until WebGPU
 * integration is verified on the live dashboard.
 */
export type DepthHeatmapBackend = "canvas2d" | "gpu";

export class DepthHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private readonly view = new DepthHeatmapPaneView();
  private readonly persistence = new DepthPersistenceAccumulator();
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private columns: DepthHistoryColumn[] = [];
  private backend: DepthHeatmapBackend = "canvas2d";
  // RA-112 (Tier 1 perf): reprojection dirty-check. updateAllViews() fires on
  // every chart repaint (including crosshair-only moves). We bump
  // `columnsVersion` whenever the depth history mutates and compare a cheap
  // signature (version + visible time range + price-axis sample) against the
  // last projection so a mousemove that changed no geometry skips the
  // ~1-2k-cell reprojection entirely.
  private columnsVersion = 0;
  private lastProjectionSignature: string | null = null;

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
    this.updateAllViews();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.persistence.clear();
    this.columns = [];
    this.columnsVersion += 1;
    this.lastProjectionSignature = null;
    this.view.update([]);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  autoscaleInfo(): AutoscaleInfo | null {
    // The heatmap calls series.priceToCoordinate() while updating its pane.
    // Returning autoscale here can make the chart re-enter this primitive while
    // resolving the same scale, which overflows the stack with dense depth
    // history. The price line and zones own the scale; depth is a draw layer.
    return null;
  }

  updateAllViews(): void {
    if (this.chart == null || this.series == null) {
      this.view.update([]);
      this.lastProjectionSignature = null;
      return;
    }
    // RA-115: in GPU mode the projection still runs so `view.cells` stays
    // populated for hit-testing (cellAtPoint / itemById). The RENDERER skips
    // the Canvas2D fillRect issuance via DepthHeatmapPaneView.setBackend(),
    // which is the actual perf win — the projection itself is cheap O(N).
    const series = this.series;
    const timeScale = this.chart.timeScale();
    const range = visibleTimeRangeSeconds(timeScale.getVisibleRange());
    // RA-112: bail out of reprojection when nothing affecting cell geometry
    // changed. The signature folds in the columns version (data churn), the
    // visible time range (time-axis pan/zoom), and two price-axis coordinate
    // samples (price-axis pan/zoom). A crosshair move that touches neither
    // axis reuses the cells already in the view.
    const signature = [
      this.columnsVersion,
      range?.from ?? "n",
      range?.to ?? "n",
      this.priceScaleSignature(series),
    ].join("|");
    if (signature === this.lastProjectionSignature) return;
    this.lastProjectionSignature = signature;
    const nowSeconds = Date.now() / 1000;
    this.view.update(
      projectDepthHeatmapCells(
        this.columns,
        (time) => this.chart?.timeScale().timeToCoordinate(time) ?? null,
        (price) => this.series?.priceToCoordinate(price) ?? null,
        {
          nowSeconds,
          visibleRange: range,
          visiblePriceRange: this.visiblePriceRange(),
        },
      ),
    );
  }

  /**
   * RA-112b: the on-screen price band, with a margin so partially-visible cells
   * still render. Computed from the main pane height + the series' price scale
   * (coordinateToPrice). Returning null disables vertical culling (renders all
   * levels) — the safe fallback if the chart isn't laid out yet.
   */
  private visiblePriceRange(): VisiblePriceRange | null {
    const chart = this.chart;
    const series = this.series;
    if (chart == null || series == null) return null;
    let height: number;
    try {
      height = chart.paneSize().height;
    } catch {
      return null;
    }
    if (!Number.isFinite(height) || height <= 0) return null;
    // 15% margin top + bottom so cells straddling the edge are not culled.
    const margin = height * 0.15;
    const top = series.coordinateToPrice(-margin);
    const bottom = series.coordinateToPrice(height + margin);
    if (top == null || bottom == null) return null;
    const a = Number(top);
    const b = Number(bottom);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }

  /**
   * RA-112: sample the price-axis mapping at two reference prices so the
   * dirty-check can detect a price-axis pan or zoom. Two samples capture both
   * translation and scale: any axis change moves at least one of them. Anchors
   * on the latest column's mid when available, else a fixed reference.
   */
  private priceScaleSignature(series: ISeriesApi<SeriesType, Time>): string {
    const mid = this.columns.at(-1)?.mid;
    const anchor = mid != null && Number.isFinite(mid) ? mid : 30000;
    const a = series.priceToCoordinate(anchor);
    const b = series.priceToCoordinate(anchor + MNQ_TICK * 40);
    return `${a ?? "n"}:${b ?? "n"}`;
  }

  appendSnapshot(payload: DepthPayload): void {
    const last = this.columns.at(-1);
    if (last && payload.ts_ns <= last.tsNs) return;
    const column = depthPayloadToColumn(payload, this.persistence);
    if (column == null) {
      // A single transient unavailable depth frame can occur while the backend
      // is between trade/mid observations. Keep the retained time x price
      // history warm; explicit session resets are handled by remount/resync.
      this.updateAllViews();
      this.requestUpdate?.();
      return;
    }

    this.columns.push(column);

    this.trimHistory(column.seconds);
    this.columnsVersion += 1;
    this.updateAllViews();
    this.requestUpdate?.();
  }

  columnCount(): number {
    return this.columns.length;
  }

  /**
   * RA-115 (Option D): swap rendering between Canvas2D and the WebGPU overlay
   * layer. Data layer (columns + persistence + history retention) is unaffected.
   * Calling this triggers a repaint so the empty/full view state takes effect.
   */
  setBackend(backend: DepthHeatmapBackend): void {
    if (this.backend === backend) return;
    this.backend = backend;
    this.view.setBackend(backend);
    this.lastProjectionSignature = null;
    this.updateAllViews();
    this.requestUpdate?.();
  }

  /**
   * RA-115: read-only view of the column buffer for the WebGPU overlay layer.
   * The GPU layer reads this on each render frame; the primitive remains the
   * canonical owner of depth history, persistence accumulation, and pruning.
   */
  getColumns(): readonly DepthHistoryColumn[] {
    return this.columns;
  }

  setHistory(payloads: readonly DepthPayload[]): void {
    // Synchronous one-shot replay path. RA-111 prefers the chunked path
    // (beginHydration + appendHydrationChunk + finalizeHydration) for cold
    // backfills, which avoids the long task RA-109 measured here. Kept for
    // test fixtures and for callers that don't need progressive rendering.
    this.beginHydration();
    this.appendHydrationChunk(payloads);
    this.finalizeHydration();
    return;
  }

  /**
   * RA-111: chunked backfill replay (1/3). Resets columns + persistence so the
   * caller can drive appendHydrationChunk over its own rAF schedule without
   * a single long task. The columns the primitive renders are kept empty until
   * the first chunk arrives, so the chart re-paints "blank then progressive"
   * rather than "blank then pop."
   */
  beginHydration(): void {
    this.columns = [];
    this.persistence.clear();
    this.columnsVersion += 1;
    this.lastProjectionSignature = null;
    this.view.update([]);
    this.requestUpdate?.();
  }

  /**
   * RA-111: chunked backfill replay (2/3). Append one chunk's worth of
   * pre-normalized depth payloads. Caller is responsible for chunk sizing
   * (e.g. HYDRATION_DEPTH_CHUNK_SIZE) and for rAF yielding between calls.
   * Re-renders incrementally so the operator sees the heatmap fill in.
   */
  appendHydrationChunk(payloads: readonly DepthPayload[]): void {
    for (const payload of normalizedDepthPayloads(payloads)) {
      const column = depthPayloadToColumn(payload, this.persistence);
      if (column == null) continue;
      this.columns.push(column);
    }
    const latest = this.columns.at(-1);
    if (latest) this.trimHistory(latest.seconds);
    this.columnsVersion += 1;
    this.updateAllViews();
    this.requestUpdate?.();
  }

  /**
   * RA-111: chunked backfill replay (3/3). Idempotent finalizer. Currently a
   * no-op (the per-chunk path already renders incrementally), but provided as
   * a stable hook for future cleanup work (e.g. coordinate cache flush).
   */
  finalizeHydration(): void {
    this.updateAllViews();
    this.requestUpdate?.();
  }

  itemById(id: unknown): DepthHeatmapCell | null {
    return this.view.itemById(id);
  }

  cellAtPoint(x: number, y: number): DepthHeatmapCell | null {
    return this.view.cellAtPoint(x, y);
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    return this.view.hitTest(x, y);
  }

  columnsForTest(): readonly DepthHistoryColumn[] {
    return this.columns;
  }

  /**
   * RA-107a: expose the current persistence-score state + last-known mid so
   * the WallMarkerManager (sibling layer) can pick top-N persistent levels
   * without re-deriving the math.
   */
  accumulatorSnapshot(): {
    scores: ReadonlyMap<number, number>;
    mid: number | null;
  } {
    const lastMid = this.columns.at(-1)?.mid ?? null;
    return { scores: this.persistence.state(), mid: lastMid };
  }

  private trimHistory(latestSeconds: number): void {
    const earliestSeconds = latestSeconds - DEPTH_HISTORY_WINDOW_SECONDS;
    while (
      this.columns.length > 0 &&
      (this.columns.length > MAX_DEPTH_COLUMNS ||
        this.columns[0].seconds < earliestSeconds)
    ) {
      this.columns.shift();
    }
  }
}

function normalizedDepthPayloads(payloads: readonly DepthPayload[]): DepthPayload[] {
  const byTs = new Map<number, DepthPayload>();
  for (const payload of payloads) byTs.set(payload.ts_ns, payload);
  return [...byTs.values()].sort((a, b) => a.ts_ns - b.ts_ns);
}
