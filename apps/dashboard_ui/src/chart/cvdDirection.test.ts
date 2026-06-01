import { describe, expect, it } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import {
  CVD_BEARISH_COLOR,
  CVD_BULLISH_COLOR,
  CVD_NEUTRAL_COLOR,
  colorCvdPoint,
  cvdDirection,
  cvdFlipMarkerFromTransition,
  cvdFlipMarkersFromPoints,
  cvdPointColor,
} from "./cvdDirection";

describe("CVD direction presentation", () => {
  it("colors CVD points by current sign", () => {
    expect(cvdDirection(10)).toBe("bullish");
    expect(cvdDirection(-10)).toBe("bearish");
    expect(cvdDirection(0)).toBe("neutral");
    expect(cvdPointColor(10)).toBe(CVD_BULLISH_COLOR);
    expect(cvdPointColor(-10)).toBe(CVD_BEARISH_COLOR);
    expect(cvdPointColor(0)).toBe(CVD_NEUTRAL_COLOR);
  });

  it("preserves lightweight-charts line data while adding per-point color", () => {
    expect(colorCvdPoint({ time: 10 as UTCTimestamp, value: -2 })).toEqual({
      time: 10,
      value: -2,
      color: CVD_BEARISH_COLOR,
    });
  });

  it("emits local zero-cross flip markers even without backend flip flags", () => {
    const markers = cvdFlipMarkersFromPoints([
      { time: 1 as UTCTimestamp, value: -3 },
      { time: 2 as UTCTimestamp, value: -1 },
      { time: 3 as UTCTimestamp, value: 2 },
      { time: 4 as UTCTimestamp, value: 5 },
      { time: 5 as UTCTimestamp, value: -1 },
    ]);

    expect(markers).toEqual([
      {
        id: "cvd-flip:3:1:local",
        time: 3,
        direction: "bullish",
        strong: false,
      },
      {
        id: "cvd-flip:5:-1:local",
        time: 5,
        direction: "bearish",
        strong: false,
      },
    ]);
  });

  it("treats compute-path momentum and vDelta flips as stronger optional markers", () => {
    expect(cvdFlipMarkerFromTransition(5, 6, 10 as UTCTimestamp, true)).toEqual({
      id: "cvd-flip:10:1:strong",
      time: 10,
      direction: "bullish",
      strong: true,
    });
  });
});
