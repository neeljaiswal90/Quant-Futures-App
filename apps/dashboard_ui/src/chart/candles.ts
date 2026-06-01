/**
 * Client-side tick -> candle aggregation (presentation only).
 *
 * The contract emits price_tick frames, not OHLC bars. To render a
 * candlestick surface we bucket ticks into fixed-interval candles purely for
 * display — this is NOT signal derivation (the backend owns signals; we are
 * only drawing the price the backend reported).
 *
 * RA-107b: the volume pane is now a TWO-series aggressor-flow split.
 * `ingest()` returns separate `buyBar` (positive) and `sellBar` (negative)
 * per bucket, plus a `hasBlockTrade` flag when the bucket contains a print
 * ≥ BLOCK_TRADE_LOTS. The single total-volume bar from the pre-RA-107b
 * API is gone; total = buy + sell, derivable if needed.
 *
 * Color carve-out from RA-100/RA-103: saturated execution-green (#3fb950)
 * and execution-red (#f85149) are reserved for trade-execution markers
 * on the price chart. The volume pane uses the green-500/red-500 family
 * (#22c55e / #ef4444) which is the AGGRESSOR-FLOW palette - distinct
 * from execution colors by hue saturation, spatially confined to the
 * secondary volume pane below the price chart.
 *
 * CVD here is a *display* cumulative-volume-delta proxy built from the
 * tick's last-vs-mid sign; it is a chart garnish, never fed back into any
 * decision. The CVD pipeline still uses `signedVolume()` and is NOT changed
 * by RA-107b.
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

/**
 * One bar of the aggressor-flow split. RA-107b: rendered as either
 * "buy" (positive value, green) or "sell" (negative value, red) on the
 * shared volume price scale. Per-bar `color` modulates by hasBlockTrade.
 */
export interface AggressorBar {
  time: UtcSeconds;
  value: number;
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
  /** RA-107b: positive-value bars for aggressive buys per bucket. */
  buyBars: HistogramData<UTCTimestamp>[];
  /** RA-107b: negative-value bars for aggressive sells per bucket. */
  sellBars: HistogramData<UTCTimestamp>[];
  cvd: LineData<UTCTimestamp>[];
}

export const CANDLE_INTERVAL_S = 1;

/**
 * RA-107b: a bucket whose largest single print meets/exceeds this size is
 * flagged as containing a block trade. Matches RA-105a's BLOCK_TRADE_LOTS
 * for chart-bubble emphasis so the operator's mental model is consistent
 * (the volume bar emphasis aligns with the chart bubble emphasis).
 */
export const BLOCK_TRADE_LOTS = 25;

/**
 * RA-111: price-tick count per chunk during cold backfill replay. Tuned to
 * keep each chunk's aggregator work under the ~16ms rAF budget at typical
 * MNQ data volume; larger chunks risk the >50ms long-task threshold RA-109
 * measured in the one-shot path.
 */
export const HYDRATION_CHUNK_SIZE = 1000;

const BUY_COLOR_NORMAL = "rgba(34, 197, 94, 0.65)";  // green-500 (RA-107b aggressor palette)
const BUY_COLOR_BLOCK = "rgba(34, 197, 94, 1.000)";
const SELL_COLOR_NORMAL = "rgba(239, 68, 68, 0.65)"; // red-500 (RA-107b aggressor palette)
const SELL_COLOR_BLOCK = "rgba(239, 68, 68, 1.000)";

export function bucketTime(
  tsNs: number,
  intervalS = CANDLE_INTERVAL_S,
): UtcSeconds {
  const sec = Math.floor(tsNs / 1e9);
  return Math.floor(sec / intervalS) * intervalS;
}

export interface IngestResult {
  candle: Candle;
  /** RA-107b: aggressor-flow buy bar (positive value). */
  buyBar: AggressorBar;
  /** RA-107b: aggressor-flow sell bar (negative value). */
  sellBar: AggressorBar;
  cvd: CvdPoint;
  /** True iff the current bucket contains a single print of size ≥ BLOCK_TRADE_LOTS. */
  hasBlockTrade: boolean;
}

/**
 * Rolling aggregator. Feed ticks in arrival order; it maintains the current
 * candle and a running CVD, plus per-bucket buy/sell volume + block-trade flag.
 * `ingest` returns the bar(s) the chart should `update()` — always the current
 * (possibly new) candle, so the caller can call series.update() once per tick
 * (NOT setData).
 */
export class CandleAggregator {
  private readonly intervalS: number;
  private current: Candle | null = null;
  // RA-107b: per-bucket aggressor-flow accumulators.
  private currentBuyVolume = 0;
  private currentSellVolume = 0;
  private currentLargestPrint = 0;
  private cvd = 0;
  private lastPrice: number | null = null;

  constructor(intervalS = CANDLE_INTERVAL_S) {
    this.intervalS = intervalS;
  }

  reset(): void {
    this.current = null;
    this.currentBuyVolume = 0;
    this.currentSellVolume = 0;
    this.currentLargestPrint = 0;
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

  /**
   * RA-107b: split this tick's lots into buy vs sell based on the wire's
   * `last_trade_aggressor` field. Falls back through `last_trade_delta`
   * sign, then the uptick heuristic, matching `signedVolume()` so the CVD
   * pipeline and the aggressor-flow pipeline stay consistent.
   */
  private aggressorVolumes(tick: PriceTickPayload | HistoricalChartTick): {
    buyVolume: number;
    sellVolume: number;
  } {
    const vol = tick.volume ?? 0;
    if (vol <= 0) return { buyVolume: 0, sellVolume: 0 };

    const aggressor =
      "orderflow" in tick ? tick.orderflow?.last_trade_aggressor : undefined;
    if (aggressor === "buy") return { buyVolume: vol, sellVolume: 0 };
    if (aggressor === "sell") return { buyVolume: 0, sellVolume: vol };

    const explicitDelta =
      "orderflow" in tick ? tick.orderflow?.last_trade_delta : tick.lastTradeDelta;
    if (typeof explicitDelta === "number") {
      if (explicitDelta > 0) return { buyVolume: vol, sellVolume: 0 };
      if (explicitDelta < 0) return { buyVolume: 0, sellVolume: vol };
      return { buyVolume: 0, sellVolume: 0 };
    }

    if (this.lastPrice == null) return { buyVolume: 0, sellVolume: 0 };
    if (tick.price > this.lastPrice) return { buyVolume: vol, sellVolume: 0 };
    if (tick.price < this.lastPrice) return { buyVolume: 0, sellVolume: vol };
    return { buyVolume: 0, sellVolume: 0 };
  }

  ingest(tick: PriceTickPayload, tsNs: number): IngestResult {
    const time = bucketTime(tsNs, this.intervalS);
    const price = tick.price;
    const signed = this.signedVolume(tick);
    this.cvd += signed;

    const { buyVolume, sellVolume } = this.aggressorVolumes(tick);
    const printSize = tick.volume ?? 0;

    if (!this.current || time > this.current.time) {
      // Open a fresh candle. Aggressor-flow + block-trade flag reset per bucket.
      this.current = { time, open: price, high: price, low: price, close: price };
      this.currentBuyVolume = buyVolume;
      this.currentSellVolume = sellVolume;
      this.currentLargestPrint = printSize;
    } else {
      this.current = {
        ...this.current,
        high: Math.max(this.current.high, price),
        low: Math.min(this.current.low, price),
        close: price,
      };
      this.currentBuyVolume += buyVolume;
      this.currentSellVolume += sellVolume;
      if (printSize > this.currentLargestPrint) {
        this.currentLargestPrint = printSize;
      }
    }
    this.lastPrice = price;

    // All four series belong to the bucket we are actually in. `this.current.time`
    // is monotonic non-decreasing by construction; the raw `time` is not (an
    // out-of-order tick, or the snapshot seed being ahead of the first live tick,
    // buckets earlier). Returning the raw time made volume/cvd `update()` go
    // backwards → "Cannot update oldest data" → the per-tick loop halted.
    const barTime = this.current.time;
    const hasBlockTrade = this.currentLargestPrint >= BLOCK_TRADE_LOTS;
    return {
      candle: this.current,
      buyBar: {
        time: barTime,
        value: this.currentBuyVolume,
        color: hasBlockTrade ? BUY_COLOR_BLOCK : BUY_COLOR_NORMAL,
      },
      sellBar: {
        time: barTime,
        // Negative value renders below zero on the shared volume scale,
        // creating the back-to-back stacked-with-zero-baseline look. Guard
        // against -0 (IEEE 754 quirk from negating an exact zero) — clean
        // +0 keeps lightweight-charts and tests happy.
        value: this.currentSellVolume === 0 ? 0 : -this.currentSellVolume,
        color: hasBlockTrade ? SELL_COLOR_BLOCK : SELL_COLOR_NORMAL,
      },
      cvd: { time: barTime, value: this.cvd },
      hasBlockTrade,
    };
  }

  /** Seed the aggregator from a snapshot price (single synthetic candle). */
  seedFromSnapshot(price: number, tsNs: number): Candle {
    const time = bucketTime(tsNs, this.intervalS);
    this.current = { time, open: price, high: price, low: price, close: price };
    this.currentBuyVolume = 0;
    this.currentSellVolume = 0;
    this.currentLargestPrint = 0;
    this.lastPrice = price;
    return this.current;
  }

  /**
   * Bulk-seed from REST backfill ticks (synchronous one-shot, kept for tests
   * and small payloads). For cold backfills under the production path,
   * prefer the chunked builder pattern: `prepareHistoryBuilder()` →
   * `ingestHistoryChunk()` × N → `finalizeHistoryBuilder()`, driven by the
   * caller's rAF schedule (see RA-111). This entrypoint internally routes
   * through that same chunked builder so the dedup + ordering semantics
   * are bit-identical between the two paths.
   */
  seedFromHistory(ticks: readonly HistoricalChartTick[]): HistoricalChartSeries {
    const builder = this.prepareHistoryBuilder();
    builder.ingestChunk(ticks);
    return builder.finalize();
  }

  /**
   * RA-111: chunked replay builder. Reset state, return an object the caller
   * drives across rAF frames. `ingestChunk()` ingests a slice through the
   * aggregator and emits the cumulative bars so far; `finalize()` returns
   * the full series and is idempotent. Sorting + dedup happen once across
   * all chunks (the builder retains pre-sorted order via Map insertion).
   */
  prepareHistoryBuilder(): HistoryBuilder {
    this.reset();
    const prices = new Map<UtcSeconds, LineData<UTCTimestamp>>();
    const buyBars = new Map<UtcSeconds, HistogramData<UTCTimestamp>>();
    const sellBars = new Map<UtcSeconds, HistogramData<UTCTimestamp>>();
    const cvd = new Map<UtcSeconds, LineData<UTCTimestamp>>();

    // Contract: caller must feed chunks in time-order. Production path
    // (PriceChart.tsx) iterates an already-sorted price_ticks array, so
    // this holds. Arrow functions close over the surrounding `this`.
    const ingestOne = (tick: HistoricalChartTick): void => {
      const next = this.ingest(toLivePriceTick(tick), tick.tsNs);
      prices.set(next.candle.time, {
        time: next.candle.time as UTCTimestamp,
        value: next.candle.close,
      });
      buyBars.set(next.buyBar.time, {
        time: next.buyBar.time as UTCTimestamp,
        value: next.buyBar.value,
        color: next.buyBar.color,
      });
      sellBars.set(next.sellBar.time, {
        time: next.sellBar.time as UTCTimestamp,
        value: next.sellBar.value,
        color: next.sellBar.color,
      });
      cvd.set(next.cvd.time, {
        time: next.cvd.time as UTCTimestamp,
        value: next.cvd.value,
      });
    };

    const snapshot = (): HistoricalChartSeries => ({
      prices: [...prices.values()],
      buyBars: [...buyBars.values()],
      sellBars: [...sellBars.values()],
      cvd: [...cvd.values()],
    });

    return {
      ingestChunk: (chunk: readonly HistoricalChartTick[]): HistoricalChartSeries => {
        // Sort the new chunk in time-order (caller may have pre-sorted, but
        // we don't trust that — sorting a 1000-item chunk is cheap). The
        // aggregator's bucket logic requires per-tick monotonic time within
        // the chunk; cumulative monotonicity across chunks is the caller's
        // responsibility (see contract note above).
        const sorted = [...chunk]
          .filter((tick) => Number.isFinite(tick.tsNs) && Number.isFinite(tick.price))
          .sort((a, b) => a.tsNs - b.tsNs);
        for (const tick of sorted) ingestOne(tick);
        return snapshot();
      },
      finalize: snapshot,
    };
  }

}

export interface HistoryBuilder {
  /**
   * Add the next chunk of historical ticks. Re-sorts the cumulative queue
   * (cheap at the scales involved), drains everything through the
   * aggregator, and returns the cumulative series so the caller can
   * setData progressively.
   */
  ingestChunk: (chunk: readonly HistoricalChartTick[]) => HistoricalChartSeries;
  /**
   * Final cumulative series. Safe to call after all chunks; idempotent if
   * called twice. Same result as `seedFromHistory()` over the concatenated
   * input.
   */
  finalize: () => HistoricalChartSeries;
}

/**
 * Lift a backfill `HistoricalChartTick` into the live `PriceTickPayload`
 * shape the aggregator's `ingest()` accepts. RA-111: extracted from the
 * old seedFromHistory body so the chunked builder and the back-compat
 * seedFromHistory share one tick-translation path.
 */
function toLivePriceTick(tick: HistoricalChartTick): PriceTickPayload {
  return {
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
  };
}
