import { describe, expect, it } from "vitest";
import {
  DEFAULT_HALF_LIFE_SECONDS,
  DepthPersistenceAccumulator,
  MAX_ACCUMULATOR_PRICE_KEYS,
} from "./depthPersistence";

const BASE_NS = 1_780_000_000_000_000_000;

function tsNs(frame: number, stepSeconds = 0.25): number {
  return BASE_NS + Math.round(frame * stepSeconds * 1_000_000_000);
}

describe("DepthPersistenceAccumulator", () => {
  it("derives score decay from wall-clock half-life", () => {
    const acc = new DepthPersistenceAccumulator();
    const price = 30_545;
    const rawSize = 10;
    const stepSeconds = 0.25;
    const decayPerStep = Math.pow(
      0.5,
      stepSeconds / DEFAULT_HALF_LIFE_SECONDS,
    );
    const steadyState = rawSize / (1 - decayPerStep);

    for (let frame = 0; frame < 2_500; frame += 1) {
      acc.update([{ price, size: rawSize }], tsNs(frame, stepSeconds));
    }

    const score = acc.state().get(price) ?? 0;
    expect(score).toBeGreaterThan(steadyState * 0.99);
    expect(score).toBeLessThan(steadyState * 1.01);
  });

  it("lets transient pops decay below the prune threshold", () => {
    const acc = new DepthPersistenceAccumulator();
    const price = 30_545;
    acc.update([{ price, size: 50 }], tsNs(0));

    for (let frame = 1; frame < 3_000; frame += 1) {
      acc.update([], tsNs(frame));
    }

    expect(acc.state().has(price)).toBe(false);
  });

  it("clears accumulated state", () => {
    const acc = new DepthPersistenceAccumulator();
    acc.update([{ price: 30_545, size: 10 }], tsNs(0));

    acc.clear();

    expect(acc.state().size).toBe(0);
  });

  it("bounds one hour of timestamped synthetic updates under the emergency cap", () => {
    const acc = new DepthPersistenceAccumulator();
    for (let second = 0; second < 3_600; second += 1) {
      const basePrice = 30_500 + (second % 160) * 0.25;
      acc.update(
        Array.from({ length: 24 }, (_, index) => ({
          price: basePrice + (index - 12) * 0.25,
          size: 2 + (index % 5),
        })),
        tsNs(second, 1),
      );
    }

    expect(acc.state().size).toBeLessThanOrEqual(MAX_ACCUMULATOR_PRICE_KEYS);
  });
});
