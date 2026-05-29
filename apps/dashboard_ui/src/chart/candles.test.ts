import { describe, expect, it } from "vitest";
import { CandleAggregator, bucketTime } from "./candles";
import type { PriceTickPayload } from "@contracts/realtime/events";

const tick = (price: number, volume = 1): PriceTickPayload => ({
  family: "price_tick",
  price,
  bid: price - 0.25,
  ask: price + 0.25,
  volume,
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

  it("resets volume per bucket", () => {
    const agg = new CandleAggregator(1);
    agg.ingest(tick(100, 5), NS(10.0));
    agg.ingest(tick(101, 5), NS(10.5)); // same bucket -> vol 10
    const r = agg.ingest(tick(102, 2), NS(11.0)); // new bucket -> vol 2
    expect(r.volume.value).toBe(2);
  });
});
