import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  AutoscaleInfo,
  Coordinate,
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  LineData,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import { formatMnqPrice, type FeedItem } from "../contract/render";
import { snapPrice } from "./priceGrid";

export const EVENT_BUBBLE_ID_PREFIX = "event-bubble:";
export const ICEBERG_COVERAGE_DECAY_MS = 5 * 60 * 1000;
const MAX_ICEBERG_COVERAGE_BANDS = 300;

export interface EventBubbleItem {
  id: string;
  time: UTCTimestamp;
  price: number;
  family: string;
  tier: FeedItem["tier"];
  side: string | null;
  direction: string | null;
  text: string;
  strength: number;
  levelId?: string | null;
  refills?: number;
  totalConsumed?: number;
}

export interface EventBubblePoint extends EventBubbleItem {
  x: number;
  y: number;
  radius: number;
  shape: EventBubbleShape;
  fillColor: string;
  strokeColor: string;
  outlineColor: string;
}

export interface HoveredEventBubble {
  item: EventBubbleItem;
  point: { x: number; y: number };
}

export interface IcebergCoverageBand {
  id: string;
  startTime: UTCTimestamp;
  endTime: UTCTimestamp;
  price: number;
  side: string | null;
  refills: number;
  totalConsumed: number;
}

export interface ProjectedIcebergCoverageBand extends IcebergCoverageBand {
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor: string;
  strokeColor: string;
}

type CoordinateFn<T> = (value: T) => Coordinate | number | null;

export type EventBubbleShape =
  | "circle"
  | "diamond"
  | "square"
  | "triangleUp"
  | "triangleDown"
  | "star"
  | "dot";

export interface EventBubbleVisual {
  shape: EventBubbleShape;
  fillColor: string;
  strokeColor: string;
  outlineColor: string;
}

export interface EventLegendItem {
  family: string;
  label: string;
  shape: EventBubbleShape;
  fillColor: string;
}

const FAMILY_VISUALS: Record<string, Omit<EventBubbleVisual, "strokeColor" | "outlineColor">> = {
  signal: { shape: "dot", fillColor: "#cbd5e1" },
  sweep: { shape: "triangleUp", fillColor: "#c084fc" },
  iceberg: { shape: "diamond", fillColor: "#67e8f9" },
  absorption: { shape: "square", fillColor: "#e5e7eb" },
  dislocation: { shape: "star", fillColor: "#f0abfc" },
  aggressor_flow: { shape: "circle", fillColor: "#818cf8" },
  vol_regime: { shape: "dot", fillColor: "#fef08a" },
};

const SIDE_STROKE = {
  bidLong: "#7dd3fc",
  askShort: "#f0abfc",
  neutral: "#cbd5e1",
} as const;

const TIER_OUTLINE: Record<string, string> = {
  CRITICAL: "#fef08a",
  HIGH: "#e9d5ff",
  MEDIUM: "#94a3b8",
};

export const EVENT_LEGEND_ITEMS: readonly EventLegendItem[] = Object.freeze([
  { family: "iceberg", label: "Iceberg", shape: "diamond", fillColor: FAMILY_VISUALS.iceberg.fillColor },
  { family: "sweep", label: "Sweep", shape: "triangleUp", fillColor: FAMILY_VISUALS.sweep.fillColor },
  { family: "absorption", label: "Absorption", shape: "square", fillColor: FAMILY_VISUALS.absorption.fillColor },
  { family: "dislocation", label: "Dislocation", shape: "star", fillColor: FAMILY_VISUALS.dislocation.fillColor },
  { family: "aggressor_flow", label: "Aggressor", shape: "circle", fillColor: FAMILY_VISUALS.aggressor_flow.fillColor },
  { family: "signal", label: "Signal", shape: "dot", fillColor: FAMILY_VISUALS.signal.fillColor },
]);

export function feedItemToBubbleItem(item: FeedItem): EventBubbleItem | null {
  if (item.price == null || !Number.isFinite(item.price)) return null;
  return {
    id: `${EVENT_BUBBLE_ID_PREFIX}${item.eventKey ?? `${item.family}|${item.tsNs}|${item.text}`}`,
    time: Math.floor(item.tsNs / 1e9) as UTCTimestamp,
    price: item.price,
    family: item.family,
    tier: item.tier,
    side: item.side ?? null,
    direction: item.direction ?? null,
    text: item.text,
    strength: item.strength,
    levelId: item.levelId ?? null,
    refills: item.refills,
    totalConsumed: item.totalConsumed,
  };
}

export function eventBubbleVisual(item: Pick<EventBubbleItem, "family" | "tier" | "side" | "direction">): EventBubbleVisual {
  const base = FAMILY_VISUALS[item.family] ?? FAMILY_VISUALS.signal;
  return {
    shape: item.family === "sweep" ? sweepShape(item.direction) : base.shape,
    fillColor: base.fillColor,
    strokeColor: sideStroke(item),
    outlineColor: item.tier ? TIER_OUTLINE[item.tier] : "rgba(203, 213, 225, 0.58)",
  };
}

export function projectBubbleItems(
  items: readonly EventBubbleItem[],
  timeToCoordinate: CoordinateFn<UTCTimestamp>,
  priceToCoordinate: CoordinateFn<number>,
): EventBubblePoint[] {
  return items.flatMap((item) => {
    const x = timeToCoordinate(item.time);
    const y = priceToCoordinate(item.price);
    if (x == null || y == null) return [];
    return [
      {
        ...item,
        x: Number(x),
        y: Number(y),
        radius: bubbleRadius(item),
        ...eventBubbleVisual(item),
      },
    ];
  });
}

export function icebergCoverageBands(
  items: readonly EventBubbleItem[],
): IcebergCoverageBand[] {
  const grouped = new Map<
    string,
    {
      startNs: number;
      endNs: number;
      price: number;
      side: string | null;
      refills: number;
      totalConsumed: number;
    }
  >();

  for (const item of items) {
    if (item.family !== "iceberg" || !Number.isFinite(item.price)) continue;
    const price = snapPrice(item.price);
    const key = item.levelId ?? `${price}|${item.side ?? ""}`;
    const existing = grouped.get(key);
    const totalConsumed = Math.max(0, item.totalConsumed ?? 0);
    const refills = Math.max(0, item.refills ?? 0);
    if (existing == null) {
      grouped.set(key, {
        startNs: item.time * 1_000_000_000,
        endNs: item.time * 1_000_000_000,
        price,
        side: item.side,
        refills,
        totalConsumed,
      });
    } else {
      existing.startNs = Math.min(existing.startNs, item.time * 1_000_000_000);
      existing.endNs = Math.max(existing.endNs, item.time * 1_000_000_000);
      existing.refills += refills;
      existing.totalConsumed += totalConsumed;
    }
  }

  return [...grouped.entries()]
    .map(([id, band]) => ({
      id,
      startTime: Math.floor(band.startNs / 1e9) as UTCTimestamp,
      endTime: Math.floor(
        band.endNs / 1e9 + ICEBERG_COVERAGE_DECAY_MS / 1000,
      ) as UTCTimestamp,
      price: band.price,
      side: band.side,
      refills: band.refills,
      totalConsumed: band.totalConsumed,
    }))
    .sort((a, b) => Number(a.endTime) - Number(b.endTime))
    .slice(-MAX_ICEBERG_COVERAGE_BANDS);
}

export function projectIcebergCoverageBands(
  items: readonly EventBubbleItem[],
  timeToCoordinate: CoordinateFn<UTCTimestamp>,
  priceToCoordinate: CoordinateFn<number>,
  visibleRange?: { from: Time; to: Time } | null,
): ProjectedIcebergCoverageBand[] {
  const range = visibleRangeSeconds(visibleRange ?? null);
  return icebergCoverageBands(items).flatMap((band) => {
    const startSeconds = Number(band.startTime);
    const endSeconds = Number(band.endTime);
    if (range && (endSeconds < range.from || startSeconds > range.to)) return [];
    const drawStart = range ? Math.max(startSeconds, range.from) : startSeconds;
    const drawEnd = range ? Math.min(endSeconds, range.to) : endSeconds;
    const xStart = timeToCoordinate(Math.floor(drawStart) as UTCTimestamp);
    const xEnd = timeToCoordinate(Math.ceil(drawEnd) as UTCTimestamp);
    const center = priceToCoordinate(band.price);
    const upper = priceToCoordinate(band.price + 0.125);
    const lower = priceToCoordinate(band.price - 0.125);
    if (xStart == null || xEnd == null || center == null) return [];
    const height =
      upper != null && lower != null
        ? Math.max(2.5, Math.min(9, Math.abs(Number(lower) - Number(upper))))
        : 4;
    return [
      {
        ...band,
        x: Number(xStart),
        y: Number(center) - height / 2,
        width: Math.max(3, Number(xEnd) - Number(xStart)),
        height,
        fillColor: icebergCoverageFill(band),
        strokeColor: icebergCoverageStroke(band),
      },
    ];
  });
}

export function eventBubbleTooltip(item: EventBubbleItem): string {
  return `${item.family} @ ${formatMnqPrice(item.price)} - ${item.text}`;
}

function visibleRangeSeconds(range: { from: Time; to: Time } | null): { from: number; to: number } | null {
  if (!range) return null;
  const from = timeValueSeconds(range.from);
  const to = timeValueSeconds(range.to);
  if (from == null || to == null) return null;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

function timeValueSeconds(time: Time): number | null {
  if (typeof time === "number") return time;
  if (typeof time === "string") {
    const parsed = Date.parse(`${time}T00:00:00Z`);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  const parsed = Date.UTC(time.year, time.month - 1, time.day) / 1000;
  return Number.isFinite(parsed) ? parsed : null;
}

function icebergCoverageFill(band: IcebergCoverageBand): string {
  const size = Math.max(1, band.totalConsumed || band.refills || 1);
  const alpha = Math.max(0.14, Math.min(0.58, 0.14 + Math.log1p(size) / Math.log1p(220) * 0.44));
  const ask = `${band.side ?? ""}`.toLowerCase().includes("ask");
  return ask ? `rgba(251, 191, 36, ${alpha.toFixed(3)})` : `rgba(250, 204, 21, ${alpha.toFixed(3)})`;
}

function icebergCoverageStroke(band: IcebergCoverageBand): string {
  const ask = `${band.side ?? ""}`.toLowerCase().includes("ask");
  return ask ? "rgba(253, 230, 138, 0.72)" : "rgba(254, 240, 138, 0.72)";
}

/**
 * Transparent time-axis foothold for the event bubbles.
 *
 * lightweight-charts `setData` requires STRICTLY ascending, UNIQUE times.
 * Signals are frequently minute-bucketed, so several events legitimately share
 * one timestamp — feeding those straight in throws "data must be asc ordered by
 * time" and crashes the chart. The anchor series is invisible and only exists so
 * event timestamps resolve on the time scale, so collapsing to one point per
 * unique time (last price wins) is loss-free for its purpose.
 */
export function anchorSeriesData(
  items: readonly EventBubbleItem[],
): LineData<UTCTimestamp>[] {
  const byTime = new Map<number, number>();
  for (const item of items) byTime.set(item.time, item.price);
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

function bubbleRadius(item: EventBubbleItem): number {
  const strengthRadius = Math.max(0, Math.min(2.2, item.strength * 2.2));
  const tierBoost = item.tier === "CRITICAL" ? 1.7 : item.tier === "HIGH" ? 0.8 : 0;
  return 2.8 + strengthRadius + tierBoost;
}

function sweepShape(direction: string | null): EventBubbleShape {
  const normalized = direction?.toLowerCase() ?? "";
  if (normalized.includes("down") || normalized.includes("short") || normalized.includes("bear")) {
    return "triangleDown";
  }
  return "triangleUp";
}

function sideStroke(item: Pick<EventBubbleItem, "side" | "direction">): string {
  const raw = `${item.side ?? ""} ${item.direction ?? ""}`.toLowerCase();
  if (
    raw.includes("bid") ||
    raw.includes("buy") ||
    raw.includes("long") ||
    raw.includes("bull") ||
    raw.includes("up")
  ) {
    return SIDE_STROKE.bidLong;
  }
  if (
    raw.includes("ask") ||
    raw.includes("sell") ||
    raw.includes("short") ||
    raw.includes("bear") ||
    raw.includes("down")
  ) {
    return SIDE_STROKE.askShort;
  }
  return SIDE_STROKE.neutral;
}

function drawEventShape(
  ctx: CanvasRenderingContext2D,
  point: EventBubblePoint,
): void {
  const r = point.shape === "dot" ? Math.max(2.2, point.radius * 0.68) : point.radius;
  switch (point.shape) {
    case "diamond":
      ctx.moveTo(point.x, point.y - r);
      ctx.lineTo(point.x + r, point.y);
      ctx.lineTo(point.x, point.y + r);
      ctx.lineTo(point.x - r, point.y);
      ctx.closePath();
      break;
    case "square":
      ctx.rect(point.x - r, point.y - r, r * 2, r * 2);
      break;
    case "triangleUp":
      ctx.moveTo(point.x, point.y - r);
      ctx.lineTo(point.x + r * 0.9, point.y + r * 0.78);
      ctx.lineTo(point.x - r * 0.9, point.y + r * 0.78);
      ctx.closePath();
      break;
    case "triangleDown":
      ctx.moveTo(point.x, point.y + r);
      ctx.lineTo(point.x + r * 0.9, point.y - r * 0.78);
      ctx.lineTo(point.x - r * 0.9, point.y - r * 0.78);
      ctx.closePath();
      break;
    case "star":
      for (let index = 0; index < 8; index += 1) {
        const angle = -Math.PI / 2 + (index * Math.PI) / 4;
        const radius = index % 2 === 0 ? r : r * 0.42;
        const x = point.x + Math.cos(angle) * radius;
        const y = point.y + Math.sin(angle) * radius;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      break;
    case "circle":
    case "dot":
      ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
      break;
  }
}

class EventBubbleRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly points: readonly EventBubblePoint[],
    private readonly coverageBands: readonly ProjectedIcebergCoverageBand[],
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const band of this.coverageBands) {
        if (band.y > mediaSize.height + 4 || band.y + band.height < -4) continue;
        ctx.save();
        ctx.fillStyle = band.fillColor;
        ctx.strokeStyle = band.strokeColor;
        ctx.lineWidth = 1;
        ctx.fillRect(band.x, band.y, band.width, band.height);
        ctx.strokeRect(band.x, band.y, band.width, band.height);
        ctx.restore();
      }
      const criticalXs = new Set(
        this.points
          .filter((point) => point.tier === "CRITICAL")
          .map((point) => Math.round(point.x)),
      );
      for (const x of criticalXs) {
        ctx.save();
        ctx.strokeStyle = "rgba(248, 81, 73, 0.26)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, mediaSize.height);
        ctx.stroke();
        ctx.restore();
      }
      for (const point of this.points) {
        ctx.save();
        ctx.beginPath();
        drawEventShape(ctx, point);
        ctx.fillStyle = point.fillColor;
        ctx.globalAlpha = 0.5;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = point.tier === "CRITICAL" ? 1.6 : 1.1;
        ctx.strokeStyle = point.strokeColor;
        ctx.stroke();
        if (point.tier === "CRITICAL" || point.tier === "HIGH") {
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.radius + 2.2, 0, Math.PI * 2);
          ctx.lineWidth = point.tier === "CRITICAL" ? 1.2 : 0.8;
          ctx.strokeStyle = point.outlineColor;
          ctx.globalAlpha = point.tier === "CRITICAL" ? 0.82 : 0.52;
          ctx.stroke();
        }
        ctx.restore();
      }
    });
  }
}

class EventBubblePaneView implements IPrimitivePaneView {
  private points: readonly EventBubblePoint[] = [];
  private coverageBands: readonly ProjectedIcebergCoverageBand[] = [];

  update(
    points: readonly EventBubblePoint[],
    coverageBands: readonly ProjectedIcebergCoverageBand[],
  ): void {
    this.points = points;
    this.coverageBands = coverageBands;
  }

  zOrder(): "normal" {
    return "normal";
  }

  renderer(): IPrimitivePaneRenderer {
    return new EventBubbleRenderer(this.points, this.coverageBands);
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    let best: { point: EventBubblePoint; distance: number } | null = null;
    for (const point of this.points) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= point.radius + 4 && (best == null || distance < best.distance)) {
        best = { point, distance };
      }
    }
    if (best == null) return null;
    return {
      externalId: best.point.id,
      zOrder: "normal",
      distance: best.distance,
      hitTestPriority: 2,
      cursorStyle: "pointer",
      itemType: "marker",
    };
  }

  itemById(id: unknown): EventBubbleItem | null {
    if (typeof id !== "string") return null;
    return this.points.find((point) => point.id === id) ?? null;
  }
}

export class EventBubblePrimitive implements ISeriesPrimitive<Time> {
  private readonly view = new EventBubblePaneView();
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private items: readonly EventBubbleItem[] = [];
  private icebergCoverageVisible = true;

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
    this.view.update([], []);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  autoscaleInfo(): AutoscaleInfo | null {
    // This primitive projects through series.priceToCoordinate() during pane
    // updates. If it also owns autoscale, lightweight-charts can re-enter the
    // primitive while resolving the price scale under dense event backfill.
    // Keep the price series/zones as the single autoscale owner.
    return null;
  }

  updateAllViews(): void {
    if (this.chart == null || this.series == null) {
      this.view.update([], []);
      return;
    }
    const points = projectBubbleItems(
        this.items,
        (time) => this.chart?.timeScale().timeToCoordinate(time) ?? null,
        (price) => this.series?.priceToCoordinate(price) ?? null,
      );
    const coverageBands = this.icebergCoverageVisible
      ? projectIcebergCoverageBands(
          this.items,
          (time) => this.chart?.timeScale().timeToCoordinate(time) ?? null,
          (price) => this.series?.priceToCoordinate(price) ?? null,
          this.chart.timeScale().getVisibleRange(),
        )
      : [];
    this.view.update(
      points,
      coverageBands,
    );
  }

  setItems(items: readonly EventBubbleItem[]): void {
    this.items = items;
    this.updateAllViews();
    this.requestUpdate?.();
  }

  setIcebergCoverageVisible(visible: boolean): void {
    this.icebergCoverageVisible = visible;
    this.updateAllViews();
    this.requestUpdate?.();
  }

  itemById(id: unknown): EventBubbleItem | null {
    return this.view.itemById(id);
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    return this.view.hitTest(x, y);
  }
}
