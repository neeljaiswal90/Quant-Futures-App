import { describe, expect, it } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import { depthPayload } from "../store/fixtures";
import { DepthPersistenceAccumulator } from "./depthPersistence";
import {
  DepthHeatmapPrimitive,
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

  it("defensively caps over-wide payloads to 100 levels per side", () => {
    const payload = {
      ...depthPayload(BASE_NS),
      bid_levels: Array.from({ length: 120 }, (_, index) => ({
        price: 30090 - index * 0.25,
        size: 1,
      })),
      ask_levels: Array.from({ length: 120 }, (_, index) => ({
        price: 30090.25 + index * 0.25,
        size: 1,
      })),
      n_ticks: 120,
    };

    const converted = depthPayloadToColumn(payload);

    expect(converted?.levels).toHaveLength(200);
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
