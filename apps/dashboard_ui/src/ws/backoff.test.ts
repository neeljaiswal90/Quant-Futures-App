import { describe, expect, it } from "vitest";
import {
  BACKOFF_CAP_MS,
  backoffBaseMs,
  backoffDelayMs,
} from "./backoff";

describe("backoff schedule", () => {
  it("doubles from 500ms base", () => {
    expect(backoffBaseMs(0)).toBe(500);
    expect(backoffBaseMs(1)).toBe(1000);
    expect(backoffBaseMs(2)).toBe(2000);
    expect(backoffBaseMs(3)).toBe(4000);
    expect(backoffBaseMs(4)).toBe(8000);
  });

  it("caps at 10s", () => {
    expect(backoffBaseMs(5)).toBe(BACKOFF_CAP_MS);
    expect(backoffBaseMs(20)).toBe(BACKOFF_CAP_MS);
  });

  it("applies +-20% jitter around the base", () => {
    // rand() = 0 -> factor 0.8 (low edge); rand() = ~1 -> factor ~1.2.
    expect(backoffDelayMs(0, () => 0)).toBe(Math.round(500 * 0.8));
    expect(backoffDelayMs(0, () => 0.999999)).toBeCloseTo(500 * 1.2, -1);
    // rand() = 0.5 -> no jitter.
    expect(backoffDelayMs(2, () => 0.5)).toBe(2000);
  });

  it("keeps jittered delay within +-20% of cap at high attempts", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const d = backoffDelayMs(50, () => r);
      expect(d).toBeGreaterThanOrEqual(Math.round(BACKOFF_CAP_MS * 0.8));
      expect(d).toBeLessThanOrEqual(Math.round(BACKOFF_CAP_MS * 1.2));
    }
  });
});
