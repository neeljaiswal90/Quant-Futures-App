import { describe, expect, it } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import { depthPayload } from "../store/fixtures";
import {
  DepthHeatmapPrimitive,
  coordinateForEpochSeconds,
  depthCellOpacity,
  depthIntensity,
  depthPayloadToColumn,
  projectDepthHeatmapCells,
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
    expect(depthIntensity(10, 100)).toBeLessThan(depthIntensity(10, 10));
  });

  it("mutes stale depth without changing the size scale", () => {
    expect(depthCellOpacity(0.8, "stale_l1")).toBeLessThan(
      depthCellOpacity(0.8, "live"),
    );
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
    expect(primitive.autoscaleInfo()).not.toBeNull();
  });
});
