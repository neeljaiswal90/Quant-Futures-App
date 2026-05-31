import { describe, expect, it } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import {
  chartTimeToDate,
  formatChartAxisTimePT,
  formatChartCrosshairTimePT,
} from "./timeFormat";

describe("chart PT time formatting", () => {
  it("formats epoch seconds on the chart axis in America/Los_Angeles time", () => {
    // 2026-05-31T23:04:09Z == 2026-05-31 16:04:09 Pacific time.
    expect(formatChartAxisTimePT(1_780_268_649 as UTCTimestamp)).toBe("16:04:09");
  });

  it("adds a PT suffix for crosshair/readout formatting", () => {
    expect(formatChartCrosshairTimePT(1_780_268_649 as UTCTimestamp)).toContain(
      "16:04:09 PT",
    );
  });

  it("keeps business-day inputs valid for lightweight-charts callbacks", () => {
    expect(chartTimeToDate({ year: 2026, month: 5, day: 31 }).toISOString()).toBe(
      "2026-05-31T00:00:00.000Z",
    );
  });
});
