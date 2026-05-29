import { describe, expect, it } from "vitest";
import {
  feedOpacity,
  formatMnqPrice,
  isFeedFamily,
  mergeZones,
  messageToFeedItem,
  messageToMarker,
  sortFeed,
  zoneColorRole,
  zoneStyle,
  zoneToPriceLine,
  type FeedItem,
} from "./render";
import {
  criticalSignalFrame,
  heartbeatFrame,
  priceTickFrame,
  sweepFrame,
} from "../store/fixtures";
import type { ZoneState } from "@contracts/realtime/events";

describe("formatMnqPrice", () => {
  it("snaps to the 0.25 tick grid", () => {
    expect(formatMnqPrice(30080)).toBe("30080.00");
    expect(formatMnqPrice(30080.12)).toBe("30080.00");
    expect(formatMnqPrice(30080.13)).toBe("30080.25");
    expect(formatMnqPrice(30080.62)).toBe("30080.50");
    expect(formatMnqPrice(30080.88)).toBe("30081.00");
  });
});

describe("zone color role", () => {
  it("maps kinds to convention roles", () => {
    expect(zoneColorRole("vpoc")).toBe("vpoc");
    expect(zoneColorRole("vah")).toBe("vpoc");
    expect(zoneColorRole("val")).toBe("vpoc");
    expect(zoneColorRole("sigma1")).toBe("sigma");
    expect(zoneColorRole("sigma2")).toBe("sigma");
    expect(zoneColorRole("demand")).toBe("demand");
    expect(zoneColorRole("supply")).toBe("supply");
    expect(zoneColorRole("wvwap")).toBe("wvwap");
    expect(zoneColorRole("something_new")).toBe("neutral");
  });

  it("supply is red, demand is green, vpoc is yellow", () => {
    expect(zoneStyle("supply").color).toBe("#f85149");
    expect(zoneStyle("demand").color).toBe("#3fb950");
    expect(zoneStyle("vpoc").color).toBe("#e3b341");
  });

  it("builds a price-line descriptor falling back to kind for the title", () => {
    const z: ZoneState = { id: "z1", kind: "demand", price: 30000, label: null };
    const line = zoneToPriceLine(z);
    expect(line.price).toBe(30000);
    expect(line.color).toBe("#3fb950");
    expect(line.title).toBe("DEMAND");
  });
});

describe("mergeZones", () => {
  it("is additive replace-by-id", () => {
    const existing: ZoneState[] = [
      { id: "a", kind: "vpoc", price: 1, label: null },
      { id: "b", kind: "vah", price: 2, label: null },
    ];
    const incoming: ZoneState[] = [
      { id: "b", kind: "vah", price: 99, label: null },
      { id: "c", kind: "wvwap", price: 3, label: null },
    ];
    const merged = mergeZones(existing, incoming);
    expect(merged).toHaveLength(3);
    expect(merged.find((z) => z.id === "b")?.price).toBe(99);
    expect(merged.find((z) => z.id === "a")).toBeDefined();
  });
});

describe("messageToMarker", () => {
  it("returns null for non-marker families", () => {
    expect(messageToMarker(priceTickFrame(2, 30080))).toBeNull();
    expect(messageToMarker(heartbeatFrame(2))).toBeNull();
  });

  it("colors a CRITICAL signal red", () => {
    const m = messageToMarker(criticalSignalFrame(2));
    expect(m).not.toBeNull();
    expect(m?.color).toBe("#f85149");
    expect(m?.text).toBe("confluence_stack");
  });

  it("maps an up sweep to an up arrow below the bar", () => {
    const m = messageToMarker(sweepFrame(2));
    expect(m?.shape).toBe("arrowUp");
    expect(m?.position).toBe("belowBar");
  });
});

describe("feed", () => {
  it("only feed families belong in the feed", () => {
    expect(isFeedFamily("signal")).toBe(true);
    expect(isFeedFamily("sweep")).toBe(true);
    expect(isFeedFamily("vol_regime")).toBe(true);
    expect(isFeedFamily("price_tick")).toBe(false);
    expect(isFeedFamily("heartbeat")).toBe(false);
    expect(isFeedFamily("snapshot")).toBe(false);
  });

  it("derives strength from tier", () => {
    expect(messageToFeedItem(criticalSignalFrame(2)).strength).toBe(1);
    expect(messageToFeedItem(sweepFrame(3)).strength).toBeCloseTo(0.66);
  });

  it("sorts by strength then recency", () => {
    const items: FeedItem[] = [
      { seq: 1, tsNs: 100, tier: "MEDIUM", family: "iceberg", text: "a", strength: 0.33 },
      { seq: 2, tsNs: 300, tier: "CRITICAL", family: "signal", text: "b", strength: 1 },
      { seq: 3, tsNs: 200, tier: "HIGH", family: "sweep", text: "c", strength: 0.66 },
      { seq: 4, tsNs: 400, tier: "CRITICAL", family: "signal", text: "d", strength: 1 },
    ];
    const sorted = sortFeed(items);
    expect(sorted.map((i) => i.seq)).toEqual([4, 2, 3, 1]);
  });
});

describe("feedOpacity time decay", () => {
  it("is full for the first 5s and floors at 0.35 by 60s", () => {
    expect(feedOpacity(0)).toBe(1);
    expect(feedOpacity(5_000)).toBe(1);
    expect(feedOpacity(60_000)).toBe(0.35);
    expect(feedOpacity(120_000)).toBe(0.35);
    const mid = feedOpacity(32_500);
    expect(mid).toBeGreaterThan(0.35);
    expect(mid).toBeLessThan(1);
  });
});
