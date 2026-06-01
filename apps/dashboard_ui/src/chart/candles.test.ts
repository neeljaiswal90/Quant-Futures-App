import { describe, expect, it } from "vitest";
import {
  BLOCK_TRADE_LOTS,
  CandleAggregator,
  HYDRATION_CHUNK_SIZE,
  bucketTime,
  type HistoricalChartTick,
} from "./candles";
import type { PriceTickPayload } from "@contracts/realtime/events";

const tick = (price: number, volume = 1): PriceTickPayload => ({
  family: "price_tick",
  price,
  bid: price - 0.25,
  ask: price + 0.25,
  volume,
  orderflow: null,
});

const tickWithDelta = (
  price: number,
  volume: number,
  delta: number,
): PriceTickPayload => ({
  ...tick(price, volume),
  orderflow: {
    quality: "high",
    last_trade_aggressor: delta > 0 ? "buy" : delta < 0 ? "sell" : "unknown",
    last_trade_delta: delta,
    cvd: null,
    aggressor_windows: [],
    v_delta: null,
    footprint: null,
  },
});

const tickWithAggressor = (
  price: number,
  volume: number,
  aggressor: "buy" | "sell" | "unknown",
): PriceTickPayload => ({
  ...tick(price, volume),
  orderflow: {
    quality: "high",
    last_trade_aggressor: aggressor,
    last_trade_delta: null,
    cvd: null,
    aggressor_windows: [],
    v_delta: null,
    footprint: null,
  },
});

const NS = (sec: number) => sec * 1e9;

describe("bucketTime", () => {
  it("floors ns to the interval in seconds", () => {
    expect(bucketTime(NS(10.7), 1)).toBe(10);
    expect(bucketTime(NS(13), 5)).toBe(10);
    expect(bucketTime(NS(17), 5)).toBe(15);
  });
});

describe("CandleAggregator", () => {
  it("builds a single candle within one bucket", () => {
    const agg = new CandleAggregator(1);
    agg.ingest(tick(100), NS(10.1));
    agg.ingest(tick(102), NS(10.4));
    const { candle } = agg.ingest(tick(101), NS(10.9));
    expect(candle.time).toBe(10);
    expect(candle.open).toBe(100);
    expect(candle.high).toBe(102);
    expect(candle.low).toBe(100);
    expect(candle.close).toBe(101);
  });

  it("opens a new candle on bucket rollover", () => {
    const agg = new CandleAggregator(1);
    agg.ingest(tick(100), NS(10.1));
    const { candle } = agg.ingest(tick(105), NS(11.1));
    expect(candle.time).toBe(11);
    expect(candle.open).toBe(105);
  });

  it("accumulates signed CVD by tick direction", () => {
    const agg = new CandleAggregator(1);
    agg.ingest(tick(100, 5), NS(10.0)); // first tick: no prior price -> 0
    let r = agg.ingest(tick(101, 3), NS(10.2)); // uptick +3
    expect(r.cvd.value).toBe(3);
    r = agg.ingest(tick(99, 4), NS(10.4)); // downtick -4
    expect(r.cvd.value).toBe(-1);
  });

  it("uses backend orderflow delta when it is present", () => {
    const agg = new CandleAggregator(1);
    agg.ingest(tickWithDelta(100, 5, 5), NS(10.0));
    const r = agg.ingest(tickWithDelta(99, 4, 4), NS(10.2));
    expect(r.cvd.value).toBe(9);
  });

  it("splits aggressor flow into buy and sell bars per bucket (RA-107b)", () => {
    const agg = new CandleAggregator(1);
    // Two buy ticks + one sell tick, same bucket
    agg.ingest(tickWithAggressor(100, 10, "buy"), NS(10.0));
    agg.ingest(tickWithAggressor(100, 5, "buy"), NS(10.3));
    const r = agg.ingest(tickWithAggressor(99, 7, "sell"), NS(10.6));

    expect(r.buyBar.value).toBe(15);
    // Sell bar is negative for the back-to-back zero-baseline render.
    expect(r.sellBar.value).toBe(-7);
    expect(r.buyBar.color).toContain("34, 197, 94"); // green-500
    expect(r.sellBar.color).toContain("239, 68, 68"); // red-500
  });

  it("resets buy/sell volume per bucket (RA-107b)", () => {
    const agg = new CandleAggregator(1);
    agg.ingest(tickWithAggressor(100, 10, "buy"), NS(10.0));
    agg.ingest(tickWithAggressor(100, 8, "sell"), NS(10.5));
    // New bucket starts at NS(11.0)
    const r = agg.ingest(tickWithAggressor(101, 3, "buy"), NS(11.0));
    expect(r.buyBar.value).toBe(3);
    expect(r.sellBar.value).toBe(0); // no sells in new bucket yet
  });

  it("flags hasBlockTrade when bucket has print >= BLOCK_TRADE_LOTS", () => {
    const agg = new CandleAggregator(1);
    expect(BLOCK_TRADE_LOTS).toBe(25);
    const small = agg.ingest(tickWithAggressor(100, 24, "buy"), NS(10.0));
    expect(small.hasBlockTrade).toBe(false);
    const block = agg.ingest(tickWithAggressor(100, 25, "buy"), NS(10.5));
    expect(block.hasBlockTrade).toBe(true);
    // The block-trade flag persists for the whole bucket once a block-size print lands.
    const followup = agg.ingest(tickWithAggressor(100, 2, "buy"), NS(10.8));
    expect(followup.hasBlockTrade).toBe(true);
    // Bar color reflects block emphasis: full alpha 1.000.
    expect(followup.buyBar.color).toContain(", 1.000)");
  });

  it("uses alpha 0.65 for normal buckets and 1.000 for block-trade buckets", () => {
    const agg = new CandleAggregator(1);
    const normal = agg.ingest(tickWithAggressor(100, 5, "buy"), NS(10.0));
    expect(normal.buyBar.color).toContain("0.65");

    const block = agg.ingest(tickWithAggressor(100, 30, "sell"), NS(20.0));
    expect(block.sellBar.color).toContain(", 1.000)");
  });

  it("falls back to last_trade_delta sign when aggressor is unknown", () => {
    const agg = new CandleAggregator(1);
    const r = agg.ingest(tickWithDelta(100, 8, 8), NS(10.0));
    expect(r.buyBar.value).toBe(8);
    expect(r.sellBar.value).toBe(0);
  });

  it("never regresses candle/buyBar/sellBar/cvd time on an out-of-order tick", () => {
    const agg = new CandleAggregator(1);
    agg.ingest(tick(100), NS(20));
    const r = agg.ingest(tick(101), NS(15)); // earlier bucket
    expect(r.candle.time).toBe(20);
    expect(r.buyBar.time).toBe(20);
    expect(r.sellBar.time).toBe(20);
    expect(r.cvd.time).toBe(20);
  });

  it("aligns all series time with the seed when the first live tick is earlier", () => {
    const agg = new CandleAggregator(1);
    agg.seedFromSnapshot(100, NS(50));
    const r = agg.ingest(tick(105), NS(48));
    expect(r.candle.time).toBe(50);
    expect(r.buyBar.time).toBe(50);
    expect(r.sellBar.time).toBe(50);
    expect(r.cvd.time).toBe(50);
  });

  it("bulk-seeds historical price, buy/sell bars, and CVD series", () => {
    const agg = new CandleAggregator(1);
    const seeded = agg.seedFromHistory([
      { tsNs: NS(10), price: 100, bid: 99.75, ask: 100.25, volume: 2, lastTradeDelta: 2 },
      { tsNs: NS(11), price: 101, bid: 100.75, ask: 101.25, volume: 3, lastTradeDelta: -3 },
    ]);

    expect(seeded.prices.map((point) => point.value)).toEqual([100, 101]);
    // Bucket 10: buy 2, sell 0. Bucket 11: buy 0, sell 3 (rendered as -3).
    expect(seeded.buyBars.map((p) => p.value)).toEqual([2, 0]);
    expect(seeded.sellBars.map((p) => p.value)).toEqual([0, -3]);
    expect(seeded.cvd.map((point) => point.value)).toEqual([2, -1]);
  });
});

describe("prepareHistoryBuilder (RA-111 chunked hydration)", () => {
  it("HYDRATION_CHUNK_SIZE = 1000", () => {
    expect(HYDRATION_CHUNK_SIZE).toBe(1000);
  });

  function syntheticTick(i: number): HistoricalChartTick {
    return {
      tsNs: NS(10 + i * 0.5),
      price: 100 + (i % 5),
      bid: 100 + (i % 5) - 0.25,
      ask: 100 + (i % 5) + 0.25,
      volume: (i % 7) + 1,
      lastTradeDelta: i % 2 === 0 ? 1 : -1,
    };
  }

  it("chunked builder produces identical final series to one-shot seedFromHistory", () => {
    // Generate 250 synthetic ticks across ~125 buckets.
    const all = Array.from({ length: 250 }, (_, i) => syntheticTick(i));
    const aggA = new CandleAggregator(1);
    const oneShot = aggA.seedFromHistory(all);

    const aggB = new CandleAggregator(1);
    const builder = aggB.prepareHistoryBuilder();
    // Feed in 5 chunks of 50.
    for (let i = 0; i < 5; i += 1) {
      builder.ingestChunk(all.slice(i * 50, (i + 1) * 50));
    }
    const chunked = builder.finalize();

    expect(chunked.prices).toEqual(oneShot.prices);
    expect(chunked.buyBars).toEqual(oneShot.buyBars);
    expect(chunked.sellBars).toEqual(oneShot.sellBars);
    expect(chunked.cvd).toEqual(oneShot.cvd);
  });

  it("ingestChunk returns cumulative series after each chunk (progressive render)", () => {
    const all = Array.from({ length: 30 }, (_, i) => syntheticTick(i));
    const agg = new CandleAggregator(1);
    const builder = agg.prepareHistoryBuilder();

    const first = builder.ingestChunk(all.slice(0, 10));
    const second = builder.ingestChunk(all.slice(10, 20));
    const third = builder.ingestChunk(all.slice(20, 30));

    // Each chunk's cumulative price-series length is monotonically non-decreasing.
    expect(first.prices.length).toBeGreaterThan(0);
    expect(second.prices.length).toBeGreaterThanOrEqual(first.prices.length);
    expect(third.prices.length).toBeGreaterThanOrEqual(second.prices.length);
    // The third chunk's series matches the one-shot result.
    const reference = new CandleAggregator(1).seedFromHistory(all);
    expect(third.prices).toEqual(reference.prices);
    expect(third.buyBars).toEqual(reference.buyBars);
    expect(third.sellBars).toEqual(reference.sellBars);
  });

  it("finalize is idempotent (safe to call twice)", () => {
    const all = Array.from({ length: 10 }, (_, i) => syntheticTick(i));
    const agg = new CandleAggregator(1);
    const builder = agg.prepareHistoryBuilder();
    builder.ingestChunk(all);
    const first = builder.finalize();
    const second = builder.finalize();
    expect(second).toEqual(first);
  });

  it("filters non-finite tsNs/price before ingesting", () => {
    const agg = new CandleAggregator(1);
    const builder = agg.prepareHistoryBuilder();
    const seeded = builder.ingestChunk([
      { tsNs: NS(10), price: 100, bid: 99.75, ask: 100.25, volume: 1, lastTradeDelta: 1 },
      { tsNs: NaN, price: 101, bid: null, ask: null, volume: 1, lastTradeDelta: 0 },
      { tsNs: NS(11), price: Infinity, bid: null, ask: null, volume: 1, lastTradeDelta: 0 },
      { tsNs: NS(12), price: 102, bid: null, ask: null, volume: 1, lastTradeDelta: 1 },
    ]);
    expect(seeded.prices.map((p) => p.value)).toEqual([100, 102]);
  });

  it("sorts ticks within each chunk in time-order before ingesting", () => {
    // Builder contract: caller must feed chunks in time-order across chunks,
    // but ticks WITHIN a chunk may be unsorted (e.g. minor reordering from
    // dedup). The builder sorts per-chunk before ingesting.
    const agg = new CandleAggregator(1);
    const builder = agg.prepareHistoryBuilder();
    const seeded = builder.ingestChunk([
      { tsNs: NS(12), price: 102, bid: 101.75, ask: 102.25, volume: 1, lastTradeDelta: 1 },
      { tsNs: NS(10), price: 100, bid: 99.75, ask: 100.25, volume: 1, lastTradeDelta: 1 },
      { tsNs: NS(11), price: 101, bid: 100.75, ask: 101.25, volume: 1, lastTradeDelta: 1 },
    ]);
    expect(seeded.prices.map((p) => p.time)).toEqual([10, 11, 12]);
  });
});
