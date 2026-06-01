import { describe, expect, it } from "vitest";
import { priceToTickKey, samePriceBucket, snapPrice, tickKeyToPrice } from "./priceGrid";

describe("price grid helpers", () => {
  it("snaps all Bookmap layers onto the same MNQ tick grid", () => {
    const key = priceToTickKey(30349.13);

    expect(tickKeyToPrice(key)).toBe(30349.25);
    expect(snapPrice(30349.13)).toBe(30349.25);
    expect(samePriceBucket(30349.13, 30349.25)).toBe(true);
  });
});
