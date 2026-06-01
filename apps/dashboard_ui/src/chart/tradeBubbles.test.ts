import { describe, expect, it } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import {
  TradeBubblePrimitive,
  projectTradeBubbles,
  tradeBubbleFromBackfillTick,
  tradeBubbleKey,
  tradeBubbleTooltip,
  type TradeBubbleTick,
} from "./tradeBubbles";

const BASE_NS = 1_780_000_000_000_000_000;

function tick(overrides: Partial<TradeBubbleTick> = {}): TradeBubbleTick {
  return {
    seq: 1,
    tsNs: BASE_NS,
    price: 30349.13,
    volume: 3,
    aggressorSide: "buy",
    lastTradeDelta: 3,
    ...overrides,
  };
}

describe("trade bubbles", () => {
  it("keys executions by trade timestamp, snapped price source, and volume", () => {
    const trade = tick();

    expect(tradeBubbleKey(trade)).toBe(`${BASE_NS}|30349.13|3`);
    expect(tradeBubbleTooltip(trade)).toBe("buy x3 @ 30349.25");
  });

  it("projects trades at the shared price grid and visible time range", () => {
    const points = projectTradeBubbles(
      [
        tick(),
        tick({ seq: 2, tsNs: BASE_NS + 10_000_000_000, price: 30350, volume: 50 }),
      ],
      (time) => (time === (BASE_NS / 1e9) as UTCTimestamp ? 120 : null),
      (price) => (price === 30349.25 ? 220 : null),
      { from: (BASE_NS / 1e9 - 1) as UTCTimestamp, to: (BASE_NS / 1e9 + 1) as UTCTimestamp },
    );

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      x: 120,
      y: 220,
      price: 30349.13,
      fillColor: "rgba(34, 197, 94, 0.74)",
    });
  });

  it("emphasizes block-size trades without changing execution colors", () => {
    const [point] = projectTradeBubbles(
      [tick({ volume: 25 })],
      (time) => (time === (BASE_NS / 1e9) as UTCTimestamp ? 120 : null),
      (price) => (price === 30349.25 ? 220 : null),
      { from: (BASE_NS / 1e9 - 1) as UTCTimestamp, to: (BASE_NS / 1e9 + 1) as UTCTimestamp },
    );

    expect(point.radius).toBeGreaterThan(10);
    expect(point.strokeColor).toBe("rgba(187, 247, 208, 1)");
  });

  it("dedupes fast and enriched records into one drawable execution", () => {
    const primitive = new TradeBubblePrimitive();
    primitive.setHistory([tick({ seq: 1, aggressorSide: "unknown", lastTradeDelta: null })]);
    primitive.appendTick(tick({ seq: 2, aggressorSide: "buy", lastTradeDelta: 3 }));

    expect(primitive.count()).toBe(1);
  });

  it("does not own chart autoscale", () => {
    const primitive = new TradeBubblePrimitive();
    primitive.setHistory([
      tick({ price: 30340, volume: 1 }),
      tick({ seq: 2, tsNs: BASE_NS + 1_000_000_000, price: 30350, volume: 10 }),
    ]);

    expect(primitive.autoscaleInfo()).toBeNull();
  });

  it("maps REST price rows to trade bubbles", () => {
    expect(
      tradeBubbleFromBackfillTick({
        seq: 9,
        ts_ns: BASE_NS,
        price: 30349.25,
        bid: null,
        ask: null,
        volume: 2,
        aggressor_side: "sell",
        orderflow_quality: "high",
        last_trade_delta: -2,
      }),
    ).toMatchObject({
      seq: 9,
      aggressorSide: "sell",
      lastTradeDelta: -2,
    });
  });
});
