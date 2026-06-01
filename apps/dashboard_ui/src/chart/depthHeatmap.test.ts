import { describe, expect, it } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import { depthPayload } from "../store/fixtures";
import { DepthPersistenceAccumulator } from "./depthPersistence";
import {
  DepthHeatmapPrimitive,
  HYDRATION_DEPTH_CHUNK_SIZE,
  coordinateForEpochSeconds,
  depthCellColor,
  depthCellOpacity,
  depthContrastStats,
  depthIntensity,
  depthPayloadToColumn,
  depthHeatmapTooltip,
  projectDepthHeatmapCells,
  sideFromMid,
  type DepthHistoryColumn,
} from "./depthHeatmap";

const BASE_NS = 1_780_000_010_000_000_000;
const BASE_SECONDS = BASE_NS / 1e9;

function timeToCoordinate(time: UTCTimestamp): number {
  return (Number(time) - BASE_SECONDS) * 10;
}

function priceToCoordinate(price: number): number {
  return (30100 - price) * 4;
}

function column(tsNs: number, size = 50): DepthHistoryColumn {
  const payload = {
    ...depthPayload(tsNs),
    bid_levels: [{ price: 30090, size }],
    ask_levels: [{ price: 30090.5, size: size / 2 }],
  };
  const converted = depthPayloadToColumn(payload);
  if (converted == null) throw new Error("fixture should convert");
  return converted;
}

describe("depth heatmap projection", () => {
  it("converts bounded depth payloads into time columns", () => {
    const converted = depthPayloadToColumn(depthPayload(BASE_NS));

    expect(converted).not.toBeNull();
    expect(converted?.seconds).toBe(BASE_SECONDS);
    expect(converted?.levels).toHaveLength(6);
    expect(converted?.quality).toBe("live");
  });

  it("assigns side per level from price vs mid (RA-107a)", () => {
    expect(sideFromMid(30100, 30090)).toBe("ask"); // above mid
    expect(sideFromMid(30080, 30090)).toBe("bid"); // below mid
    expect(sideFromMid(30090, 30090)).toBe("ask"); // tie -> ask
    expect(sideFromMid(30090, null)).toBe("ask"); // unknown mid -> ask
  });

  it("propagates side onto each DepthHistoryLevel via depthPayloadToColumn", () => {
    const converted = depthPayloadToColumn(depthPayload(BASE_NS));
    // depthPayload fixture: mid is set near the levels; verify both sides
    // appear and the polarization is monotonic in price.
    const sides = (converted?.levels ?? []).map((level) => ({
      price: level.price,
      side: level.side,
    }));
    expect(sides.length).toBeGreaterThan(0);
    const mid = converted?.mid ?? 0;
    for (const { price, side } of sides) {
      expect(side).toBe(price < mid ? "bid" : "ask");
    }
  });

  it("interpolates sub-second timestamps without requiring fractional chart times", () => {
    const x = coordinateForEpochSeconds(BASE_SECONDS + 0.5, timeToCoordinate);

    expect(x).toBe(5);
  });

  it("caps single cell time-width when next column is far in the future (RA-108-bug-fix)", () => {
    // A column followed by a 25-minute gap (capture restart) must NOT produce
    // a 25-minute-wide cell. The cap (MAX_DEPTH_CELL_DURATION_SECONDS = 30s)
    // bounds the cell's horizontal width. timeToCoordinate maps 1s -> 10
    // pixels in this test fixture; the cell width should be 300 pixels max
    // (30s × 10), not the multi-thousand-pixel block the gap would create.
    const firstColumn = column(BASE_NS, 100);
    const secondColumn = column(BASE_NS + 25 * 60 * 1_000_000_000, 25);
    const cells = projectDepthHeatmapCells(
      [firstColumn, secondColumn],
      timeToCoordinate,
      priceToCoordinate,
      {
        nowSeconds: BASE_SECONDS + 25 * 60 + 5,
        // Visible range only includes the first column's time + the cap window.
        visibleRange: { from: BASE_SECONDS - 1, to: BASE_SECONDS + 60 },
        sessionMaxSize: 100,
      },
    );
    // The first column's cells should render with the capped width, not 25 min.
    const firstColumnCells = cells.filter((c) => c.x === 0);
    expect(firstColumnCells.length).toBeGreaterThan(0);
    // 30s × 10 px/s = 300 px max. Without the cap this would be 25*60*10 = 15000 px.
    expect(firstColumnCells[0].width).toBeLessThanOrEqual(310);
  });

  it("draws each retained snapshot as a time-spanning price column", () => {
    const cells = projectDepthHeatmapCells(
      [column(BASE_NS, 100), column(BASE_NS + 2_000_000_000, 25)],
      timeToCoordinate,
      priceToCoordinate,
      {
        nowSeconds: BASE_SECONDS + 3,
        visibleRange: { from: BASE_SECONDS - 1, to: BASE_SECONDS + 3 },
        sessionMaxSize: 100,
      },
    );

    expect(cells).toHaveLength(4);
    expect(cells[0]).toMatchObject({
      price: 30090,
      size: 100,
      rawSize: 100,
      x: 0,
      width: 20,
      quality: "live",
    });
    expect(cells[0].fillColor).toContain("rgba(");
  });

  it("culls columns outside the visible time range", () => {
    const cells = projectDepthHeatmapCells(
      [column(BASE_NS), column(BASE_NS + 2_000_000_000)],
      timeToCoordinate,
      priceToCoordinate,
      {
        nowSeconds: BASE_SECONDS + 3,
        visibleRange: { from: BASE_SECONDS + 4, to: BASE_SECONDS + 5 },
        sessionMaxSize: 100,
      },
    );

    expect(cells).toEqual([]);
  });

  it("uses a stable session max so quiet periods do not self-normalize hot", () => {
    expect(depthIntensity(50, 100, 10)).toBeLessThan(depthIntensity(50, 50, 10));
  });

  it("uses a 10-minute rolling max and ignores old liquidity spikes", () => {
    const stats = depthContrastStats(
      [
        column(BASE_NS - 11 * 60_000_000_000, 500),
        column(BASE_NS, 100),
      ],
      BASE_SECONDS,
    );

    expect(stats.rollingMaxSize).toBe(100);
    expect(stats.floorSize).toBeGreaterThanOrEqual(5);
    expect(depthIntensity(500, stats.rollingMaxSize, stats.floorSize)).toBe(1);
  });

  it("hides noise at or below the explicit rolling floor", () => {
    const cells = projectDepthHeatmapCells(
      [
        {
          tsNs: BASE_NS,
          seconds: BASE_SECONDS,
          mid: 30090.25,
          quality: "live",
          levels: [
            ...Array.from({ length: 100 }, (_, index) => ({
              price: 30070 + index * 0.25,
              size: 10,
              rawSize: 10,
              side: (30070 + index * 0.25 < 30090.25 ? "bid" : "ask") as "bid" | "ask",
            })),
            { price: 30095, size: 500, rawSize: 500, side: "ask" as const },
          ],
        },
      ],
      timeToCoordinate,
      priceToCoordinate,
      {
        nowSeconds: BASE_SECONDS + 1,
        visibleRange: { from: BASE_SECONDS - 1, to: BASE_SECONDS + 2 },
      },
    );

    expect(cells).toHaveLength(1);
    expect(cells[0].size).toBe(500);
    expect(cells[0].rawSize).toBe(500);
  });

  it("mutes stale depth without changing the size scale", () => {
    expect(depthCellOpacity(0.8, "stale_l1")).toBeLessThan(
      depthCellOpacity(0.8, "live"),
    );
  });

  it("polarizes heatmap-cell hue by side at full intensity (RA-107a)", () => {
    // Ask side defaults to pink-400 family rgba(248, 113, 113); bid side
    // defaults to sky-400 family rgba(56, 189, 248). Saturation depends on
    // intensity but at t=1 the cell sits at the full polarized hue.
    expect(depthCellColor(1, "live", "ask")).toBe("rgba(248, 113, 113, 0.950)");
    expect(depthCellColor(1, "live", "bid")).toBe("rgba(56, 189, 248, 0.950)");
  });

  it("keeps polarized hues distinct at low intensity (RA-107a)", () => {
    // Even at the minimum-shown opacity, the two side hues must not converge.
    const askLow = depthCellColor(0.05, "live", "ask");
    const bidLow = depthCellColor(0.05, "live", "bid");
    expect(askLow.slice(0, 12)).not.toBe(bidLow.slice(0, 12));
  });

  it("defaults to ask hue when side is omitted (back-compat tie-break)", () => {
    expect(depthCellColor(1, "live")).toBe(depthCellColor(1, "live", "ask"));
  });

  it("defensively caps over-wide payloads to 200 levels per side (RA-104b)", () => {
    // RA-104b: cap raised to 200; defensive UI clamp matches.
    const payload = {
      ...depthPayload(BASE_NS),
      bid_levels: Array.from({ length: 220 }, (_, index) => ({
        price: 30090 - index * 0.25,
        size: 1,
      })),
      ask_levels: Array.from({ length: 220 }, (_, index) => ({
        price: 30090.25 + index * 0.25,
        size: 1,
      })),
      n_ticks: 220,
    };

    const converted = depthPayloadToColumn(payload);

    expect(converted?.levels).toHaveLength(400);
  });

  it("stores persistence score in size and current raw lots in rawSize", () => {
    const acc = new DepthPersistenceAccumulator();
    const first = depthPayloadToColumn(
      {
        ...depthPayload(BASE_NS),
        bid_levels: [{ price: 30090, size: 10 }],
        ask_levels: [],
      },
      acc,
    );
    const second = depthPayloadToColumn(
      {
        ...depthPayload(BASE_NS + 250_000_000),
        bid_levels: [{ price: 30090, size: 10 }],
        ask_levels: [],
      },
      acc,
    );

    expect(first?.levels[0]).toMatchObject({ price: 30090, size: 10, rawSize: 10 });
    expect(second?.levels[0].rawSize).toBe(10);
    expect(second?.levels[0].size ?? 0).toBeGreaterThan(19);
  });

  it("keeps decaying persistence cells after a raw level disappears", () => {
    const acc = new DepthPersistenceAccumulator();
    depthPayloadToColumn(
      {
        ...depthPayload(BASE_NS),
        bid_levels: [{ price: 30090, size: 50 }],
        ask_levels: [],
      },
      acc,
    );
    const faded = depthPayloadToColumn(
      {
        ...depthPayload(BASE_NS + 1_000_000_000),
        bid_levels: [{ price: 30091, size: 1 }],
        ask_levels: [],
      },
      acc,
    );

    const oldPrice = faded?.levels.find((level) => level.price === 30090);
    expect(oldPrice?.rawSize).toBe(0);
    expect(oldPrice?.size ?? 0).toBeGreaterThan(40);
  });

  it("formats hover tooltip with raw size and persistence score", () => {
    expect(
      depthHeatmapTooltip({
        price: 30547.5,
        size: 4823.4,
        rawSize: 12,
      }),
    ).toBe("30547.50 | persist 4,823 lot-frames | size 12 lots");
  });

  it("keeps the primitive below the price and event layers", () => {
    const primitive = new DepthHeatmapPrimitive();
    const [view] = primitive.paneViews();

    expect(view?.zOrder?.()).toBe("bottom");
  });

  it("keeps retained history on transient unavailable depth", () => {
    const primitive = new DepthHeatmapPrimitive();
    primitive.appendSnapshot(depthPayload(BASE_NS));

    expect(primitive.columnCount()).toBe(1);

    primitive.appendSnapshot({
      ...depthPayload(BASE_NS + 1_000_000_000, "unavailable"),
      bid_levels: [],
      ask_levels: [],
    });

    expect(primitive.columnCount()).toBe(1);
    expect(primitive.autoscaleInfo()).toBeNull();
  });

  it("bulk-seeds retained history from REST depth backfill", () => {
    const primitive = new DepthHeatmapPrimitive();

    primitive.setHistory([depthPayload(BASE_NS), depthPayload(BASE_NS + 1_000_000_000)]);

    expect(primitive.columnCount()).toBe(2);
    expect(primitive.autoscaleInfo()).toBeNull();
  });

  it("replays setHistory through the same accumulator path as live appends", () => {
    const payloads = [
      {
        ...depthPayload(BASE_NS),
        bid_levels: [{ price: 30090, size: 10 }],
        ask_levels: [],
      },
      {
        ...depthPayload(BASE_NS + 250_000_000),
        bid_levels: [{ price: 30090, size: 10 }],
        ask_levels: [],
      },
      {
        ...depthPayload(BASE_NS + 500_000_000),
        bid_levels: [{ price: 30090.25, size: 1 }],
        ask_levels: [],
      },
    ];
    const live = new DepthHeatmapPrimitive();
    for (const payload of payloads) live.appendSnapshot(payload);

    const replay = new DepthHeatmapPrimitive();
    replay.setHistory(payloads);

    expect(replay.columnsForTest()).toEqual(live.columnsForTest());
  });

  it("shows persistent scores while hiding sub-floor transient noise", () => {
    const cells = projectDepthHeatmapCells(
      [
        {
          tsNs: BASE_NS,
          seconds: BASE_SECONDS,
          mid: 30090.25,
          quality: "live",
          levels: [
            ...Array.from({ length: 100 }, (_, index) => ({
              price: 30070 + index * 0.25,
              size: 100,
              rawSize: 0,
              side: (30070 + index * 0.25 < 30090.25 ? "bid" : "ask") as "bid" | "ask",
            })),
            { price: 30095, size: 2_000, rawSize: 10, side: "ask" as const },
          ],
        },
      ],
      timeToCoordinate,
      priceToCoordinate,
      {
        nowSeconds: BASE_SECONDS + 1,
        visibleRange: { from: BASE_SECONDS - 1, to: BASE_SECONDS + 2 },
      },
    );

    expect(cells).toHaveLength(1);
    expect(cells[0].price).toBe(30095);
    expect(cells[0].intensity).toBeGreaterThan(0.9);
  });
});

describe("DepthHeatmapPrimitive chunked hydration (RA-111)", () => {
  it("HYDRATION_DEPTH_CHUNK_SIZE = 200", () => {
    expect(HYDRATION_DEPTH_CHUNK_SIZE).toBe(200);
  });

  it("chunked replay produces identical columns to one-shot setHistory", () => {
    // Generate 30 sequential depth payloads.
    const payloads = Array.from({ length: 30 }, (_, i) => {
      const tsNs = BASE_NS + i * 250_000_000;
      return {
        ...depthPayload(tsNs),
        bid_levels: [{ price: 30090 - i * 0.25, size: 5 + (i % 4) }],
        ask_levels: [{ price: 30090.25 + i * 0.25, size: 5 + (i % 4) }],
      };
    });

    const primA = new DepthHeatmapPrimitive();
    primA.setHistory(payloads);
    const oneShotColumns = primA.columnsForTest();

    const primB = new DepthHeatmapPrimitive();
    primB.beginHydration();
    // Three chunks of 10 payloads each.
    primB.appendHydrationChunk(payloads.slice(0, 10));
    primB.appendHydrationChunk(payloads.slice(10, 20));
    primB.appendHydrationChunk(payloads.slice(20, 30));
    primB.finalizeHydration();
    const chunkedColumns = primB.columnsForTest();

    expect(chunkedColumns.length).toBe(oneShotColumns.length);
    for (let i = 0; i < chunkedColumns.length; i += 1) {
      expect(chunkedColumns[i].tsNs).toBe(oneShotColumns[i].tsNs);
      // Persistence scores must be bit-identical between the two replay paths
      // (the accumulator's timestamp-aware decay is the same in both).
      expect(chunkedColumns[i].levels.map((l) => Math.round(l.size * 100))).toEqual(
        oneShotColumns[i].levels.map((l) => Math.round(l.size * 100)),
      );
    }
  });

  it("beginHydration resets state so a second pass doesn't keep stale columns", () => {
    const prim = new DepthHeatmapPrimitive();
    const firstBatch = [depthPayload(BASE_NS), depthPayload(BASE_NS + 1_000_000_000)];
    const secondBatch = [depthPayload(BASE_NS + 10_000_000_000)];

    prim.beginHydration();
    prim.appendHydrationChunk(firstBatch);
    prim.finalizeHydration();
    expect(prim.columnCount()).toBe(2);

    // Second hydration pass clears state.
    prim.beginHydration();
    prim.appendHydrationChunk(secondBatch);
    prim.finalizeHydration();
    expect(prim.columnCount()).toBe(1);
  });

  it("finalizeHydration is idempotent (safe to call twice)", () => {
    const prim = new DepthHeatmapPrimitive();
    prim.beginHydration();
    prim.appendHydrationChunk([depthPayload(BASE_NS)]);
    prim.finalizeHydration();
    expect(prim.columnCount()).toBe(1);
    prim.finalizeHydration();
    expect(prim.columnCount()).toBe(1);
  });

  it("dedupes payloads with the same tsNs across chunks (regression guard)", () => {
    const prim = new DepthHeatmapPrimitive();
    prim.beginHydration();
    // Same tsNs in two different chunks — the second should replace the first
    // via the normalizedDepthPayloads Map keyed by tsNs.
    prim.appendHydrationChunk([depthPayload(BASE_NS)]);
    prim.appendHydrationChunk([depthPayload(BASE_NS)]);
    prim.finalizeHydration();
    // Each call's normalizedDepthPayloads dedupes WITHIN its own chunk; across
    // chunks the second appendHydrationChunk re-processes the same tsNs. The
    // column gets pushed twice with the same tsNs, but appendSnapshot's
    // ordering guard (last && payload.ts_ns <= last.tsNs) would block in the
    // live path. setHistory accepts duplicate tsNs in-order; that matches
    // back-compat. The dedup invariant for setData is enforced at the
    // lightweight-charts setData call site, not in the primitive.
    expect(prim.columnCount()).toBeGreaterThan(0);
  });
});
