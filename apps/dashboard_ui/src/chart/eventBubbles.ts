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
import { formatMnqPrice, type FeedItem } from "../contract/render";

export const EVENT_BUBBLE_ID_PREFIX = "event-bubble:";

export interface EventBubbleItem {
  id: string;
  time: UTCTimestamp;
  price: number;
  family: string;
  tier: FeedItem["tier"];
  text: string;
  strength: number;
}

export interface EventBubblePoint extends EventBubbleItem {
  x: number;
  y: number;
  radius: number;
  fillColor: string;
  strokeColor: string;
}

export interface HoveredEventBubble {
  item: EventBubbleItem;
  point: { x: number; y: number };
}

type CoordinateFn<T> = (value: T) => Coordinate | number | null;

const FAMILY_FILL: Record<string, string> = {
  signal: "#58a6ff",
  sweep: "#22c55e",
  iceberg: "#38bdf8",
  absorption: "#f97316",
  dislocation: "#ef4444",
  aggressor_flow: "#14b8a6",
};

const TIER_STROKE: Record<string, string> = {
  CRITICAL: "#f85149",
  HIGH: "#e3b341",
  MEDIUM: "#58a6ff",
};

export function feedItemToBubbleItem(item: FeedItem): EventBubbleItem | null {
  if (item.price == null || !Number.isFinite(item.price)) return null;
  return {
    id: `${EVENT_BUBBLE_ID_PREFIX}${item.eventKey ?? `${item.family}|${item.tsNs}|${item.text}`}`,
    time: Math.floor(item.tsNs / 1e9) as UTCTimestamp,
    price: item.price,
    family: item.family,
    tier: item.tier,
    text: item.text,
    strength: item.strength,
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
        fillColor: FAMILY_FILL[item.family] ?? "#8b949e",
        strokeColor: item.tier ? TIER_STROKE[item.tier] : "#c9d1d9",
      },
    ];
  });
}

export function eventBubbleTooltip(item: EventBubbleItem): string {
  return `${item.family} @ ${formatMnqPrice(item.price)} - ${item.text}`;
}

function bubbleRadius(item: EventBubbleItem): number {
  const strengthRadius = Math.max(0, Math.min(4, item.strength * 4));
  const tierBoost = item.tier === "CRITICAL" ? 3 : item.tier === "HIGH" ? 1.5 : 0;
  return 4 + strengthRadius + tierBoost;
}

class EventBubbleRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly points: readonly EventBubblePoint[]) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const point of this.points) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
        ctx.fillStyle = point.fillColor;
        ctx.globalAlpha = 0.82;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = point.tier === "CRITICAL" ? 2.5 : 1.5;
        ctx.strokeStyle = point.strokeColor;
        ctx.stroke();
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

  zOrder(): "top" {
    return "top";
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
      zOrder: "top",
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
