import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  AutoscaleInfo,
  Coordinate,
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { DepthPayload, DepthQuality } from "@contracts/realtime/events";
import { MNQ_TICK } from "../contract/render";

export const DEPTH_HISTORY_WINDOW_SECONDS = 8 * 60 * 60;
export const MAX_DEPTH_COLUMNS = 12_000;
export const MAX_VISIBLE_DEPTH_COLUMNS = 420;
export const MAX_DEPTH_CELLS = 32_000;
export const MIN_DEPTH_CELL_WIDTH = 1.5;

export interface DepthHistoryLevel {
  price: number;
  size: number;
}

export interface DepthHistoryColumn {
  tsNs: number;
  seconds: number;
  mid: number | null;
  quality: DepthQuality;
  levels: DepthHistoryLevel[];
}

export interface DepthHeatmapCell extends DepthHistoryLevel {
  x: number;
  y: number;
  width: number;
  height: number;
  intensity: number;
  fillColor: string;
  quality: DepthQuality;
}

export interface VisibleTimeRangeSeconds {
  from: number;
  to: number;
}

type CoordinateFn<T> = (value: T) => Coordinate | number | null;

export function depthPayloadToColumn(payload: DepthPayload): DepthHistoryColumn | null {
  if (
    payload.quality === "unavailable" ||
    payload.bid_levels.length + payload.ask_levels.length === 0
  ) {
    return null;
  }

  const levels = [...payload.bid_levels, ...payload.ask_levels]
    .filter((level) => (
      Number.isFinite(level.price) &&
      Number.isFinite(level.size) &&
      level.size > 0
    ))
    .map((level) => ({ price: level.price, size: level.size }));

  if (levels.length === 0) return null;

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

export function depthIntensity(size: number, sessionMaxSize: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  if (!Number.isFinite(sessionMaxSize) || sessionMaxSize <= 0) return 0;
  const scaled = Math.log1p(size) / Math.log1p(sessionMaxSize);
  return Math.max(0, Math.min(1, scaled));
}

export function depthCellOpacity(intensity: number, quality: DepthQuality): number {
  const base = 0.08 + Math.max(0, Math.min(1, intensity)) * 0.58;
  if (quality === "stale_l1") return base * 0.35;
  if (quality === "inferred") return base * 0.72;
  return quality === "live" ? base : 0;
}

export function depthCellColor(intensity: number, quality: DepthQuality): string {
  const t = Math.max(0, Math.min(1, intensity));
  const red = Math.round(45 + t * 210);
  const green = Math.round(112 + t * 96);
  const blue = Math.round(225 - t * 165);
  return `rgba(${red}, ${green}, ${blue}, ${depthCellOpacity(t, quality).toFixed(3)})`;
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
    const endSeconds = Math.max(startSeconds + 0.25, nextSeconds);
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
  const sessionMaxSize = options.sessionMaxSize ?? maxDepthSize(columns);
  if (columns.length === 0 || sessionMaxSize <= 0) return [];

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
      const intensity = depthIntensity(level.size, sessionMaxSize);
      cells.push({
        ...level,
        x: xStart,
        y: band.y,
        width,
        height: band.height,
        intensity,
        fillColor: depthCellColor(intensity, interval.column.quality),
        quality: interval.column.quality,
      });
      if (cells.length >= maxCells) return cells;
    }
  }

  return cells;
}

class DepthHeatmapRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly cells: readonly DepthHeatmapCell[]) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const cell of this.cells) {
        if (cell.y > mediaSize.height + 4 || cell.y + cell.height < -4) continue;
        ctx.save();
        ctx.fillStyle = cell.fillColor;
        ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
        ctx.restore();
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
}

export class DepthHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private readonly view = new DepthHeatmapPaneView();
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private columns: DepthHistoryColumn[] = [];
  private sessionMaxSize = 0;

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
    this.view.update([]);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  autoscaleInfo(): AutoscaleInfo | null {
    if (this.columns.length === 0) return null;
    const prices = this.columns.flatMap((column) =>
      column.levels.map((level) => level.price),
    );
    if (prices.length === 0) return null;
    const minValue = Math.min(...prices);
    const maxValue = Math.max(...prices);
    return {
      priceRange: {
        minValue: minValue - MNQ_TICK,
        maxValue: maxValue + MNQ_TICK,
      },
    };
  }

  updateAllViews(): void {
    if (this.chart == null || this.series == null) {
      this.view.update([]);
      return;
    }
    const range = visibleTimeRangeSeconds(this.chart.timeScale().getVisibleRange());
    const nowSeconds = Date.now() / 1000;
    this.view.update(
      projectDepthHeatmapCells(
        this.columns,
        (time) => this.chart?.timeScale().timeToCoordinate(time) ?? null,
        (price) => this.series?.priceToCoordinate(price) ?? null,
        {
          nowSeconds,
          visibleRange: range,
          sessionMaxSize: this.sessionMaxSize,
        },
      ),
    );
  }

  appendSnapshot(payload: DepthPayload): void {
    const column = depthPayloadToColumn(payload);
    if (column == null) {
      // A single transient unavailable depth frame can occur while the backend
      // is between trade/mid observations. Keep the retained time x price
      // history warm; explicit session resets are handled by remount/resync.
      this.updateAllViews();
      this.requestUpdate?.();
      return;
    }

    const last = this.columns.at(-1);
    if (last && column.tsNs < last.tsNs) return;
    if (last && column.tsNs === last.tsNs) {
      this.columns[this.columns.length - 1] = column;
    } else {
      this.columns.push(column);
    }

    this.sessionMaxSize = Math.max(this.sessionMaxSize, maxDepthSize([column]));
    this.trimHistory(column.seconds);
    this.updateAllViews();
    this.requestUpdate?.();
  }

  columnCount(): number {
    return this.columns.length;
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
