/**
 * Client-side tick -> candle aggregation (presentation only).
 *
 * The contract emits price_tick frames, not OHLC bars. To render a
 * candlestick surface we bucket ticks into fixed-interval candles purely for
 * display — this is NOT signal derivation (the backend owns signals; we are
 * only drawing the price the backend reported).
 *
 * CVD here is a *display* cumulative-volume-delta proxy built from the tick's
 * last-vs-mid sign; it is a chart garnish, never fed back into any decision.
 */
import type { HistogramData, LineData, UTCTimestamp } from "lightweight-charts";
import type { PriceTickPayload } from "@contracts/realtime/events";

/** lightweight-charts UTCTimestamp (epoch seconds). */
export type UtcSeconds = number;

export interface Candle {
  time: UtcSeconds;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumeBar {
  time: UtcSeconds;
  value: number;
  /** Up/down coloring relative to the candle direction. */
  color: string;
}

export interface CvdPoint {
  time: UtcSeconds;
  value: number;
}

export interface HistoricalChartTick {
  tsNs: number;
  price: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  lastTradeDelta?: number | null;
}

export interface HistoricalChartSeries {
  prices: LineData<UTCTimestamp>[];
  volumes: HistogramData<UTCTimestamp>[];
  cvd: LineData<UTCTimestamp>[];
}

export const CANDLE_INTERVAL_S = 1;

export function bucketTime(
  tsNs: number,
  intervalS = CANDLE_INTERVAL_S,
): UtcSeconds {
  const sec = Math.floor(tsNs / 1e9);
  return Math.floor(sec / intervalS) * intervalS;
}

const UP = "#26a69a";
const DOWN = "#ef5350";

/**
 * Rolling aggregator. Feed ticks in arrival order; it maintains the current
 * candle and a running CVD. `ingest` returns the bar(s) the chart should
 * `update()` — always the current (possibly new) candle, so the caller can
 * call series.update() once per tick (NOT setData).
 */
export class CandleAggregator {
  private readonly intervalS: number;
  private current: Candle | null = null;
  private currentVolume = 0;
  private cvd = 0;
  private lastPrice: number | null = null;

  constructor(intervalS = CANDLE_INTERVAL_S) {
    this.intervalS = intervalS;
  }

  reset(): void {
    this.current = null;
    this.currentVolume = 0;
    this.cvd = 0;
    this.lastPrice = null;
  }

  /** Signed volume: backend/orderflow delta when present, else uptick proxy. */
  private signedVolume(tick: PriceTickPayload | HistoricalChartTick): number {
    const explicitDelta =
      "orderflow" in tick ? tick.orderflow?.last_trade_delta : tick.lastTradeDelta;
    if (typeof explicitDelta === "number") {
      return explicitDelta;
    }
    const vol = tick.volume ?? 0;
    if (this.lastPrice == null) return 0;
    if (tick.price > this.lastPrice) return vol;
    if (tick.price < this.lastPrice) return -vol;
    return 0;
  }

  ingest(
    tick: PriceTickPayload,
    tsNs: number,
  ): { candle: Candle; volume: VolumeBar; cvd: CvdPoint } {
    const time = bucketTime(tsNs, this.intervalS);
    const price = tick.price;
    const signed = this.signedVolume(tick);
    this.cvd += signed;

    if (!this.current || time > this.current.time) {
      // Open a fresh candle. Volume resets per bucket.
      this.current = { time, open: price, high: price, low: price, close: price };
      this.currentVolume = tick.volume ?? 0;
    } else {
      this.current = {
        ...this.current,
        high: Math.max(this.current.high, price),
        low: Math.min(this.current.low, price),
        close: price,
      };
      this.currentVolume += tick.volume ?? 0;
    }
    this.lastPrice = price;

    // All three series belong to the bucket we are actually in. `this.current.time`
    // is monotonic non-decreasing by construction; the raw `time` is not (an
    // out-of-order tick, or the snapshot seed being ahead of the first live tick,
    // buckets earlier). Returning the raw time made volume/cvd `update()` go
    // backwards → "Cannot update oldest data" → the per-tick loop halted.
    const barTime = this.current.time;
    const up = this.current.close >= this.current.open;
    return {
      candle: this.current,
      volume: { time: barTime, value: this.currentVolume, color: up ? UP : DOWN },
      cvd: { time: barTime, value: this.cvd },
    };
  }

  /** Seed the aggregator from a snapshot price (single synthetic candle). */
  seedFromSnapshot(price: number, tsNs: number): Candle {
    const time = bucketTime(tsNs, this.intervalS);
    this.current = { time, open: price, high: price, low: price, close: price };
    this.currentVolume = 0;
    this.lastPrice = price;
    return this.current;
  }

  /** Bulk-seed from REST backfill ticks and leave the aggregator at the last tick. */
  seedFromHistory(ticks: readonly HistoricalChartTick[]): HistoricalChartSeries {
    this.reset();
    const prices = new Map<UtcSeconds, LineData<UTCTimestamp>>();
    const volumes = new Map<UtcSeconds, HistogramData<UTCTimestamp>>();
    const cvd = new Map<UtcSeconds, LineData<UTCTimestamp>>();
    const ordered = [...ticks]
      .filter((tick) => Number.isFinite(tick.tsNs) && Number.isFinite(tick.price))
      .sort((a, b) => a.tsNs - b.tsNs);

    for (const tick of ordered) {
      const next = this.ingest(
        {
          family: "price_tick",
          price: tick.price,
          bid: tick.bid,
          ask: tick.ask,
          volume: tick.volume,
          orderflow:
            typeof tick.lastTradeDelta === "number"
              ? {
                  quality: "high",
                  last_trade_aggressor:
                    tick.lastTradeDelta > 0
                      ? "buy"
                      : tick.lastTradeDelta < 0
                        ? "sell"
                        : "unknown",
                  last_trade_delta: tick.lastTradeDelta,
                  cvd: null,
                  aggressor_windows: [],
                  v_delta: null,
                  footprint: null,
                }
              : null,
        },
        tick.tsNs,
      );
      prices.set(next.candle.time, {
        time: next.candle.time as UTCTimestamp,
        value: next.candle.close,
      });
      volumes.set(next.volume.time, {
        time: next.volume.time as UTCTimestamp,
        value: next.volume.value,
        color: next.volume.color,
      });
      cvd.set(next.cvd.time, {
        time: next.cvd.time as UTCTimestamp,
        value: next.cvd.value,
      });
    }

    return {
      prices: [...prices.values()],
      volumes: [...volumes.values()],
      cvd: [...cvd.values()],
    };
  }
}
