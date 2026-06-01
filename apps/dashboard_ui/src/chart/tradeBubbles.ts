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
import type { BookmapPriceTickRecord, TradeAggressorSide } from "../bookmap/backfill";
import { formatMnqPrice } from "../contract/render";
import { snapPrice } from "./priceGrid";

export const TRADE_BUBBLE_ID_PREFIX = "trade-bubble:";
export const TRADE_HISTORY_WINDOW_SECONDS = 8 * 60 * 60;
export const MAX_TRADE_BUBBLES = 100_000;
export const MAX_VISIBLE_TRADE_BUBBLES = 2_500;

type CoordinateFn<T> = (value: T) => Coordinate | number | null;

export interface TradeBubbleTick {
  seq: number;
  tsNs: number;
  price: number;
  volume: number | null;
  aggressorSide: TradeAggressorSide;
  lastTradeDelta: number | null;
}

export interface TradeBubblePoint extends TradeBubbleTick {
  id: string;
  time: UTCTimestamp;
  x: number;
  y: number;
  radius: number;
  fillColor: string;
  strokeColor: string;
}

export interface HoveredTradeBubble {
  item: TradeBubbleTick;
  point: { x: number; y: number };
}

export function tradeBubbleFromBackfillTick(
  tick: BookmapPriceTickRecord,
): TradeBubbleTick {
  return {
    seq: tick.seq,
    tsNs: tick.ts_ns,
    price: tick.price,
    volume: tick.volume,
    aggressorSide: tick.aggressor_side,
    lastTradeDelta: tick.last_trade_delta,
  };
}

export function tradeBubbleKey(tick: Pick<TradeBubbleTick, "tsNs" | "price" | "volume">): string {
  return `${tick.tsNs}|${tick.price}|${tick.volume ?? 0}`;
}

export function tradeBubbleTooltip(tick: TradeBubbleTick): string {
  const side = tick.aggressorSide === "unknown" ? "trade" : tick.aggressorSide;
  const size = tick.volume == null ? "" : ` x${tick.volume}`;
  return `${side}${size} @ ${formatMnqPrice(tick.price)}`;
}

export function projectTradeBubbles(
  ticks: readonly TradeBubbleTick[],
  timeToCoordinate: CoordinateFn<UTCTimestamp>,
  priceToCoordinate: CoordinateFn<number>,
  visibleRange?: { from: Time; to: Time } | null,
): TradeBubblePoint[] {
  const range = visibleRangeSeconds(visibleRange ?? null);
  const visible = range
    ? ticks.filter((tick) => {
        const seconds = tick.tsNs / 1e9;
        return seconds >= range.from && seconds <= range.to;
      })
    : ticks;
  const stride =
    visible.length > MAX_VISIBLE_TRADE_BUBBLES
      ? Math.ceil(visible.length / MAX_VISIBLE_TRADE_BUBBLES)
      : 1;
  const points: TradeBubblePoint[] = [];
  for (let index = 0; index < visible.length; index += stride) {
    const tick = visible[index];
    const time = Math.floor(tick.tsNs / 1e9) as UTCTimestamp;
    const x = timeToCoordinate(time);
    const y = priceToCoordinate(snapPrice(tick.price));
    if (x == null || y == null) continue;
    points.push({
      ...tick,
      id: `${TRADE_BUBBLE_ID_PREFIX}${tradeBubbleKey(tick)}`,
      time,
      x: Number(x),
      y: Number(y),
      radius: tradeBubbleRadius(tick.volume),
      fillColor: tradeBubbleFill(tick.aggressorSide),
      strokeColor: tradeBubbleStroke(tick.aggressorSide),
    });
  }
  return points;
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

function tradeBubbleRadius(volume: number | null): number {
  const size = Math.max(1, volume ?? 1);
  return Math.max(2.5, Math.min(16, 2.2 + Math.log1p(size) * 2.2));
}

function tradeBubbleFill(side: TradeAggressorSide): string {
  if (side === "buy") return "rgba(34, 197, 94, 0.74)";
  if (side === "sell") return "rgba(239, 68, 68, 0.74)";
  return "rgba(226, 232, 240, 0.52)";
}

function tradeBubbleStroke(side: TradeAggressorSide): string {
  if (side === "buy") return "rgba(134, 239, 172, 0.92)";
  if (side === "sell") return "rgba(252, 165, 165, 0.92)";
  return "rgba(203, 213, 225, 0.72)";
}

class TradeBubbleRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly points: readonly TradeBubblePoint[]) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const point of this.points) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
        ctx.fillStyle = point.fillColor;
        ctx.fill();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = point.strokeColor;
        ctx.stroke();
        ctx.restore();
      }
    });
  }
}

class TradeBubblePaneView implements IPrimitivePaneView {
  private points: readonly TradeBubblePoint[] = [];

  update(points: readonly TradeBubblePoint[]): void {
    this.points = points;
  }

  zOrder(): "top" {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer {
    return new TradeBubbleRenderer(this.points);
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    let best: { point: TradeBubblePoint; distance: number } | null = null;
    for (const point of this.points) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= point.radius + 3 && (best == null || distance < best.distance)) {
        best = { point, distance };
      }
    }
    if (!best) return null;
    return {
      externalId: best.point.id,
      zOrder: "top",
      distance: best.distance,
      hitTestPriority: 3,
      cursorStyle: "pointer",
      itemType: "marker",
    };
  }

  itemById(id: unknown): TradeBubbleTick | null {
    if (typeof id !== "string") return null;
    return this.points.find((point) => point.id === id) ?? null;
  }
}

export class TradeBubblePrimitive implements ISeriesPrimitive<Time> {
  private readonly view = new TradeBubblePaneView();
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly byKey = new Map<string, TradeBubbleTick>();
  private items: TradeBubbleTick[] = [];

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
    const prices = this.items.map((item) => snapPrice(item.price));
    const minValue = Math.min(...prices);
    const maxValue = Math.max(...prices);
    return { priceRange: { minValue: minValue - 0.25, maxValue: maxValue + 0.25 } };
  }

  updateAllViews(): void {
    if (this.chart == null || this.series == null) {
      this.view.update([]);
      return;
    }
    this.view.update(
      projectTradeBubbles(
        this.items,
        (time) => this.chart?.timeScale().timeToCoordinate(time) ?? null,
        (price) => this.series?.priceToCoordinate(price) ?? null,
        this.chart.timeScale().getVisibleRange(),
      ),
    );
  }

  setHistory(ticks: readonly TradeBubbleTick[]): void {
    this.byKey.clear();
    for (const tick of ticks) this.byKey.set(tradeBubbleKey(tick), tick);
    this.rebuildItems();
    this.updateAllViews();
    this.requestUpdate?.();
  }

  appendTick(tick: TradeBubbleTick): void {
    this.byKey.set(tradeBubbleKey(tick), tick);
    this.rebuildItems();
    this.updateAllViews();
    this.requestUpdate?.();
  }

  itemById(id: unknown): TradeBubbleTick | null {
    return this.view.itemById(id);
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    return this.view.hitTest(x, y);
  }

  count(): number {
    return this.items.length;
  }

  private rebuildItems(): void {
    this.items = [...this.byKey.values()].sort((a, b) => a.tsNs - b.tsNs || a.seq - b.seq);
    const latest = this.items.at(-1);
    if (!latest) return;
    const cutoff = latest.tsNs - TRADE_HISTORY_WINDOW_SECONDS * 1_000_000_000;
    this.items = this.items
      .filter((item) => item.tsNs >= cutoff)
      .slice(-MAX_TRADE_BUBBLES);
    this.byKey.clear();
    for (const item of this.items) this.byKey.set(tradeBubbleKey(item), item);
  }
}
