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

export const EVENT_BUBBLE_ID_PREFIX = "event-bubble:";

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

export function eventBubbleTooltip(item: EventBubbleItem): string {
  return `${item.family} @ ${formatMnqPrice(item.price)} - ${item.text}`;
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
  constructor(private readonly points: readonly EventBubblePoint[]) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
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

  update(points: readonly EventBubblePoint[]): void {
    this.points = points;
  }

  zOrder(): "normal" {
    return "normal";
  }

  renderer(): IPrimitivePaneRenderer {
    return new EventBubbleRenderer(this.points);
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
    if (this.items.length === 0) return null;
    const prices = this.items.map((item) => item.price);
    const minValue = Math.min(...prices);
    const maxValue = Math.max(...prices);
    const padding = Math.max(0.25, (maxValue - minValue) * 0.04);
    return {
      priceRange: {
        minValue: minValue - padding,
        maxValue: maxValue + padding,
      },
    };
  }

  updateAllViews(): void {
    if (this.chart == null || this.series == null) {
      this.view.update([]);
      return;
    }
    this.view.update(
      projectBubbleItems(
        this.items,
        (time) => this.chart?.timeScale().timeToCoordinate(time) ?? null,
        (price) => this.series?.priceToCoordinate(price) ?? null,
      ),
    );
  }

  setItems(items: readonly EventBubbleItem[]): void {
    this.items = items;
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
