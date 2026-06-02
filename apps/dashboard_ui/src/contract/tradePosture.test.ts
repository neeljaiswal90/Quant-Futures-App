import { describe, expect, it } from "vitest";
import type { Shelf, ZoneState } from "@contracts/realtime/events";
import { deriveTradePosture } from "./tradePosture";

const ANCHOR = 30463.95;

function shelf(over: Partial<Shelf>): Shelf {
  return {
    family: "sigma_v3_vwap_anchor",
    name: "SUP_1",
    low: 0,
    high: 0,
    tier: 1,
    bound_source: "estimator",
    cap_bound: false,
    overlaps_vah: false,
    overlaps_val: false,
    nearest_structural_level: null,
    distance_to_structural_level_ticks: null,
    ...over,
  };
}

const SHELVES: Shelf[] = [
  shelf({ name: "SUP_1", tier: 1, low: ANCHOR,          high: 30476.86, bound_source: "estimator",
          nearest_structural_level: "vpoc", distance_to_structural_level_ticks: 17 }),
  shelf({ name: "SUP_2", tier: 2, low: 30476.86,        high: 30489.78 }),
  shelf({ name: "SUP_3", tier: 3, low: 30489.78,        high: 30502.69 }),
  shelf({ name: "DEM_1", tier: 1, low: 30447.70,        high: ANCHOR, bound_source: "atr_cap", cap_bound: true }),
  shelf({ name: "DEM_2", tier: 2, low: 30431.45,        high: 30447.70, bound_source: "atr_cap", cap_bound: true }),
  shelf({ name: "DEM_3", tier: 3, low: 30415.20,        high: 30431.45, bound_source: "atr_cap", cap_bound: true,
          overlaps_val: true, nearest_structural_level: "val", distance_to_structural_level_ticks: 3 }),
];

const ZONES: ZoneState[] = [
  { id: "vpoc", kind: "vpoc", price: 30466, label: "VPOC 30466" },
  { id: "vah",  kind: "vah",  price: 30560, label: "VAH 30560"  },
  { id: "val",  kind: "val",  price: 30424, label: "VAL 30424"  },
];

function input(over: Partial<Parameters<typeof deriveTradePosture>[0]>) {
  return deriveTradePosture({
    price: 30468.75,
    shelves: SHELVES,
    zones: ZONES,
    depth: null,
    bid: 30468.50,
    ask: 30468.75,
    auctionState: "inside_value",
    auctionDistanceTicks: 0,
    regime: "LOW",
    mbpPulse: null,
    ...over,
  });
}

describe("tradePosture — auction range", () => {
  it("anchor + auctionHigh + auctionLow read from σ shelf boundaries", () => {
    const p = input({});
    expect(p.anchor).toBe(ANCHOR);
    expect(p.auctionHigh).toBe(30502.69); // SUP_3 high
    expect(p.auctionLow).toBe(30415.20);  // DEM_3 low
  });

  it("cap-bound flags carry through from outer tier shelves", () => {
    const p = input({});
    expect(p.auctionHighCapBound).toBe(false); // SUP_3 estimator
    expect(p.auctionLowCapBound).toBe(true);   // DEM_3 cap
  });
});

describe("tradePosture — direction classification", () => {
  it("price inside SUP_1 → FADE_SHORT", () => {
    const p = input({ price: 30470 });
    expect(p.direction).toBe("FADE_SHORT");
    expect(p.containingShelf?.name).toBe("SUP_1");
  });

  it("price inside DEM_2 → FADE_LONG", () => {
    const p = input({ price: 30440 });
    expect(p.direction).toBe("FADE_LONG");
    expect(p.containingShelf?.name).toBe("DEM_2");
  });

  it("price within 2 ticks of anchor → AT_ANCHOR", () => {
    const p = input({ price: ANCHOR + 0.25 });
    expect(p.direction).toBe("AT_ANCHOR");
  });

  it("price above SUP_3 cap → OUTSIDE_RANGE_UP", () => {
    const p = input({ price: 30510 });
    expect(p.direction).toBe("OUTSIDE_RANGE_UP");
  });

  it("price below DEM_3 cap → OUTSIDE_RANGE_DN", () => {
    const p = input({ price: 30400 });
    expect(p.direction).toBe("OUTSIDE_RANGE_DN");
  });

  it("no price → UNKNOWN", () => {
    const p = input({ price: null });
    expect(p.direction).toBe("UNKNOWN");
  });
});

describe("tradePosture — conviction vs auction bias", () => {
  it("FADE_SHORT in BELOW_VALUE bias = WITH_BIAS (short aligns with bearish trend)", () => {
    const p = input({ price: 30470, auctionState: "below_value" });
    expect(p.conviction).toBe("WITH_BIAS");
  });

  it("FADE_LONG in BELOW_VALUE bias = AGAINST_BIAS (long fights bearish trend)", () => {
    const p = input({ price: 30440, auctionState: "below_value" });
    expect(p.conviction).toBe("AGAINST_BIAS");
  });

  it("FADE_LONG in ABOVE_VALUE bias = WITH_BIAS (long aligns with bullish trend)", () => {
    const p = input({ price: 30440, auctionState: "above_value" });
    expect(p.conviction).toBe("WITH_BIAS");
  });

  it("INSIDE_VALUE → NEUTRAL regardless of direction", () => {
    expect(input({ price: 30470, auctionState: "inside_value" }).conviction).toBe("NEUTRAL");
    expect(input({ price: 30440, auctionState: "inside_value" }).conviction).toBe("NEUTRAL");
  });
});

describe("tradePosture — confluence", () => {
  it("strong confluence when distance ≤ 4 ticks", () => {
    const p = input({ price: 30420 }); // in DEM_3 (val nearby, dist=3)
    expect(p.confluence?.level).toBe("val");
    expect(p.confluence?.strong).toBe(true);
  });

  it("non-strong confluence when distance > 4 ticks", () => {
    const p = input({ price: 30470 }); // in SUP_1 (vpoc, dist=17)
    expect(p.confluence?.level).toBe("vpoc");
    expect(p.confluence?.strong).toBe(false);
  });

  it("null when no structural level on the containing shelf", () => {
    const p = input({ price: 30440 }); // DEM_2 has no structural metadata in fixture
    expect(p.confluence).toBeNull();
  });
});

describe("tradePosture — trade levels", () => {
  it("FADE_SHORT: stop above SUP_2 high + buffer; targets ladder anchor → DEM_1 mid → VAL", () => {
    const p = input({ price: 30470 });
    expect(p.tradeLevels?.entryZone.low).toBe(ANCHOR);
    expect(p.tradeLevels?.entryZone.high).toBe(30476.86);
    expect(p.tradeLevels?.stopPrice).toBe(30489.78 + 1.0); // SUP_2 high + 4-tick buffer
    expect(p.tradeLevels?.targets[0].label).toMatch(/anchor/);
    expect(p.tradeLevels?.targets[0].price).toBe(ANCHOR);
    expect(p.tradeLevels?.targets[1].price).toBeCloseTo((30447.70 + ANCHOR) / 2);
    expect(p.tradeLevels?.targets.at(-1)?.label).toContain("VAL");
  });

  it("FADE_LONG: stop below DEM_2 low - buffer; targets ladder anchor → SUP_1 mid → VAH", () => {
    const p = input({ price: 30455 }); // in DEM_1
    expect(p.tradeLevels?.stopPrice).toBe(30431.45 - 1.0);
    expect(p.tradeLevels?.targets[0].price).toBe(ANCHOR);
    expect(p.tradeLevels?.targets.at(-1)?.label).toContain("VAH");
  });

  it("no tradeLevels when AT_ANCHOR or OUTSIDE_RANGE", () => {
    expect(input({ price: ANCHOR + 0.25 }).tradeLevels).toBeNull();
    expect(input({ price: 30510 }).tradeLevels).toBeNull();
  });
});

describe("tradePosture — MBP1 readouts", () => {
  it("spread in ticks from bid/ask", () => {
    const p = input({ bid: 30468.50, ask: 30468.75 });
    expect(p.mbp.spreadTicks).toBe(1);
  });

  it("depth imbalance from top-of-book sizes", () => {
    const p = input({
      depth: {
        family: "depth",
        ts_ns: 0,
        mid: 30468.625,
        n_ticks: 100,
        quality: "live",
        bid_levels: [{ price: 30468.50, size: 80 }],
        ask_levels: [{ price: 30468.75, size: 20 }],
      },
    });
    expect(p.mbp.depthImbalance).toBeCloseTo(0.6, 5);
    expect(p.mbp.bidShare).toBeCloseTo(0.8, 5);
  });

  it("microprice offset leans toward the heavier side", () => {
    // Heavy bid (80) vs thin ask (20) → microprice closer to ask price → positive offset
    const p = input({
      depth: {
        family: "depth",
        ts_ns: 0,
        mid: 30468.625,
        n_ticks: 100,
        quality: "live",
        bid_levels: [{ price: 30468.50, size: 80 }],
        ask_levels: [{ price: 30468.75, size: 20 }],
      },
    });
    expect(p.mbp.micropriceOffsetTicks).not.toBeNull();
    expect(p.mbp.micropriceOffsetTicks!).toBeGreaterThan(0);
  });

  it("OFI is null when no pulse has landed yet", () => {
    expect(input({ mbpPulse: null }).mbp.ofi30s).toBeNull();
  });

  it("when MBP pulse is present, posture reads ALL readouts from it (step 7)", () => {
    const p = input({
      mbpPulse: {
        family: "mbp_pulse",
        ts_ns: 1_000_000_000,
        ofi_5s: 12, ofi_15s: 25, ofi_30s: 42, ofi_60s: 78,
        trade_imbalance_5s: 0.6, trade_imbalance_15s: 0.45,
        trade_imbalance_30s: 0.3, trade_imbalance_60s: 0.2,
        approach_speed_1s: null, approach_speed_5s: 2.1, approach_speed_15s: 1.4,
        depth_imbalance_touch: 0.34, depth_imbalance_mean_5s: 0.3,
        microprice_offset_touch: 0.42, microprice_offset_mean_5s: 0.4,
        spread_touch: 1, spread_max_5s: 1,
      },
    });
    expect(p.mbp.ofi30s).toBe(42);
    expect(p.mbp.spreadTicks).toBe(1);
    expect(p.mbp.depthImbalance).toBe(0.34);
    expect(p.mbp.micropriceOffsetTicks).toBe(0.42);
    // bidShare derived from imbalance: (imbalance + 1) / 2
    expect(p.mbp.bidShare).toBeCloseTo(0.67, 2);
  });

  it("pulse takes precedence over client-side depth math", () => {
    // Provide BOTH pulse + depth — pulse wins.
    const p = input({
      depth: {
        family: "depth",
        ts_ns: 0,
        mid: 30468.625,
        n_ticks: 100,
        quality: "live",
        bid_levels: [{ price: 30468.50, size: 999 }],  // misleading
        ask_levels: [{ price: 30468.75, size: 1 }],
      },
      mbpPulse: {
        family: "mbp_pulse",
        ts_ns: 1_000_000_000,
        ofi_5s: null, ofi_15s: null, ofi_30s: null, ofi_60s: null,
        trade_imbalance_5s: null, trade_imbalance_15s: null,
        trade_imbalance_30s: null, trade_imbalance_60s: null,
        approach_speed_1s: null, approach_speed_5s: null, approach_speed_15s: null,
        depth_imbalance_touch: 0,   // pulse says BALANCED
        depth_imbalance_mean_5s: 0,
        microprice_offset_touch: 0,
        microprice_offset_mean_5s: 0,
        spread_touch: 1, spread_max_5s: 2,
      },
    });
    expect(p.mbp.depthImbalance).toBe(0);  // pulse, not derived from depth
    expect(p.mbp.spreadTicks).toBe(1);     // pulse, not bid/ask
  });
});

describe("tradePosture — position within tier", () => {
  it("0 at low edge, 1 at high edge, ~0.5 at mid", () => {
    expect(input({ price: ANCHOR }).positionWithinTier).toBe(0);
    expect(input({ price: 30476.86 }).positionWithinTier).toBe(1);
    expect(input({ price: (ANCHOR + 30476.86) / 2 }).positionWithinTier).toBeCloseTo(0.5, 1);
  });

  it("null when outside any shelf", () => {
    expect(input({ price: 30510 }).positionWithinTier).toBeNull();
  });
});
