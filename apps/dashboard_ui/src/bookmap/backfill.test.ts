import { describe, expect, it } from "vitest";
import type { RealtimeMessage } from "@contracts/realtime/events";
import {
  mergeBackfillWithLiveFrames,
  normalizeBookmapBackfill,
  priceTickKey,
} from "./backfill";

function message(seq: number, tsNs: number, payload: RealtimeMessage["payload"]): RealtimeMessage {
  return {
    type: "event",
    seq,
    ts_ns: tsNs,
    ts_pt: "2026-06-01 05:45:00 PT",
    tier: null,
    schema_version: 1,
    payload,
  };
}

describe("Bookmap REST backfill normalization", () => {
  it("normalizes bounded price and depth history", () => {
    const normalized = normalizeBookmapBackfill({
      schema_version: 1,
      trading_date: "2026-06-01",
      session: "globex",
      generated_at_ns: 1_000,
      through_seq: 42,
      limits: {
        price_ticks_max: 100_000,
        depth_columns_max: 12_000,
        max_age_seconds: 28_800,
      },
      price_ticks: [
        {
          seq: 3,
          ts_ns: 300,
          price: 30349.25,
          bid: 30349,
          ask: 30349.5,
          volume: 2,
          aggressor_side: "buy",
          orderflow_quality: "high",
          last_trade_delta: 2,
        },
      ],
      depth: [
        {
          seq: 4,
          family: "depth",
          ts_ns: 301,
          mid: 30349.25,
          bid_levels: [{ price: 30349, size: 55 }],
          ask_levels: [{ price: 30349.5, size: 21 }],
          n_ticks: 20,
          quality: "live",
        },
      ],
    });

    expect(normalized?.through_seq).toBe(42);
    expect(normalized?.price_ticks).toHaveLength(1);
    expect(normalized?.depth[0]).toMatchObject({
      family: "depth",
      quality: "live",
      n_ticks: 20,
    });
  });

  it("merges live frames into REST history by trade identity", () => {
    const backfill = normalizeBookmapBackfill({
      price_ticks: [
        {
          seq: 1,
          ts_ns: 100,
          price: 30349.25,
          volume: 3,
          aggressor_side: "unknown",
          orderflow_quality: null,
          last_trade_delta: null,
        },
      ],
      depth: [],
    });
    if (!backfill) throw new Error("fixture should normalize");

    const merged = mergeBackfillWithLiveFrames(backfill, [
      message(2, 100, {
        family: "price_tick",
        price: 30349.25,
        bid: 30349,
        ask: 30349.5,
        volume: 3,
        orderflow: {
          quality: "high",
          last_trade_aggressor: "buy",
          last_trade_delta: 3,
          cvd: null,
          aggressor_windows: [],
          v_delta: null,
          footprint: null,
        },
      }),
      message(3, 101, {
        family: "depth",
        ts_ns: 101,
        mid: 30349.25,
        bid_levels: [{ price: 30349, size: 55 }],
        ask_levels: [],
        n_ticks: 20,
        quality: "live",
      }),
    ]);

    expect(merged.price_ticks).toHaveLength(1);
    expect(priceTickKey(merged.price_ticks[0])).toBe("100|30349.25|3");
    expect(merged.price_ticks[0]).toMatchObject({
      seq: 2,
      aggressor_side: "buy",
      last_trade_delta: 3,
    });
    expect(merged.depth).toHaveLength(1);
    expect(merged.depth[0].seq).toBe(3);
  });
});
