import { describe, expect, it } from "vitest";
import { BLOCK_TRADE_LOTS, CandleAggregator, bucketTime } from "./candles";
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
