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
export const MAX_DEPTH_CELLS = 32_000;
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
export const DEPTH_CONTRAST_PERCENTILE = 0.25;
export const DEPTH_CONTRAST_MIN_SCORE = 5.0;
export const DEPTH_INTENSITY_POWER = 0.5;
export const DEPTH_MIN_SHOWN_OPACITY = 0.15;
export const DEPTH_MAX_OPACITY = 0.95;
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
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.floor((values.length - 1) * pct)),
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
  let rollingMaxSize = 0;

  for (const column of columns) {
    if (column.seconds < cutoffSeconds || column.seconds > nowSeconds) continue;
    for (const level of column.levels) {
      if (!Number.isFinite(level.size) || level.size <= 0) continue;
      sizes.push(level.size);
      if (level.size > rollingMaxSize) rollingMaxSize = level.size;
    }
  }

  if (sizes.length === 0 || rollingMaxSize <= 0) {
    return { rollingMaxSize: 0, floorSize: 0 };
  }

  sizes.sort((a, b) => a - b);
  const p25 = percentile(sizes, DEPTH_CONTRAST_PERCENTILE);
  return {
    rollingMaxSize,
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
 * RA-107a: liquidity-context palette polarized by side.
 *
 *   Ask side (sellers defending ceiling): pink-400 family rgba(248, 113, 113).
 *   Bid side (buyers defending floor):    sky-400 family rgba(56, 189, 248).
 *
 * Intensity drives opacity (via depthCellOpacity); hue indicates SIDE.
 *
 * Carve-out from RA-100/RA-103: saturated execution-green (#3fb950) and
 * execution-red (#f85149) stay reserved for trade-execution markers on the
 * price chart. Pink-400 + sky-400 are visually distinct enough that an
 * operator does not confuse them with execution markers.
 */
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

export function depthCellColor(
  intensity: number,
  quality: DepthQuality,
  side: DepthSide = "ask",
): string {
  const t = Math.max(0, Math.min(1, intensity));
  const alpha = depthCellOpacity(t, quality);
  if (side === "ask") {
    // dark wine -> pink-400
    const r = Math.round(100 + t * 148);
    const g = Math.round(30 + t * 83);
    const b = Math.round(30 + t * 83);
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
  }
  // dark navy -> sky-400
  const r = Math.round(20 + t * 36);
  const g = Math.round(60 + t * 129);
  const b = Math.round(100 + t * 148);
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
}

export function projectDepthHeatmapCells(
  columns: readonly DepthHistoryColumn[],
  timeToCoordinate: CoordinateFn<UTCTimestamp>,
  priceToCoordinate: CoordinateFn<number>,
  options: ProjectDepthOptions,
): DepthHeatmapCell[] {
  const visibleRange = options.visibleRange ?? null;
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
  for (const interval of intervals) {
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
      if (cells.length >= maxCells) return cells;
    }
  }

  return cells;
}

export function depthHeatmapTooltip(cell: Pick<DepthHeatmapCell, "price" | "size" | "rawSize">): string {
  return `${formatMnqPrice(cell.price)} | persist ${Math.round(cell.size).toLocaleString()} lot-frames | size ${Math.round(cell.rawSize).toLocaleString()} lots`;
}

class DepthHeatmapRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly cells: readonly DepthHeatmapCell[]) {}

  draw(target: CanvasRenderingTarget2D): void {
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

  update(cells: readonly DepthHeatmapCell[]): void {
    this.cells = cells;
  }

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer {
    return new DepthHeatmapRenderer(this.cells);
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

export class DepthHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private readonly view = new DepthHeatmapPaneView();
  private readonly persistence = new DepthPersistenceAccumulator();
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private columns: DepthHistoryColumn[] = [];
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
        },
      ),
    );
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
