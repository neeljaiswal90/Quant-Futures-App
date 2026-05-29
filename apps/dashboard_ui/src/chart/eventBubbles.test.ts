import { describe, expect, it } from "vitest";
import {
  anchorSeriesData,
  EVENT_BUBBLE_ID_PREFIX,
  EventBubblePrimitive,
  eventBubbleTooltip,
  feedItemToBubbleItem,
  projectBubbleItems,
  type EventBubbleItem,
} from "./eventBubbles";
import type { UTCTimestamp } from "lightweight-charts";
import type { FeedItem } from "../contract/render";

describe("event bubbles", () => {
  it("skips feed items without a price", () => {
    const item: FeedItem = {
      seq: 1,
      tsNs: 1_780_000_000_000_000_000,
      tier: "MEDIUM",
      family: "sweep",
      text: "sweep without price",
      strength: 0.4,
    };

    expect(feedItemToBubbleItem(item)).toBeNull();
  });

  it("maps priced feed items into stable bubble identities", () => {
    const item: FeedItem = {
      seq: 2,
      tsNs: 1_780_000_000_500_000_000,
      tier: "HIGH",
      family: "iceberg",
      price: 30350.25,
      eventKey: "iceberg|known",
      text: "iceberg at entry",
      strength: 0.8,
    };

    const bubble = feedItemToBubbleItem(item);

    expect(bubble).not.toBeNull();
    expect(bubble?.id).toBe(`${EVENT_BUBBLE_ID_PREFIX}iceberg|known`);
    expect(bubble?.time).toBe(1_780_000_000);
    expect(bubble?.price).toBe(30350.25);
  });

  it("projects time and price into chart coordinates", () => {
    const items: EventBubbleItem[] = [
      {
        id: "a",
        time: 100 as UTCTimestamp,
        price: 30340.5,
        tier: "CRITICAL",
        family: "dislocation",
        text: "dislocation",
        strength: 0.9,
      },
      {
        id: "offscreen",
        time: 101 as UTCTimestamp,
        price: 1,
        tier: null,
        family: "sweep",
        text: "hidden",
        strength: 0.4,
      },
    ];

    const projected = projectBubbleItems(
      items,
      (time) => (time === 100 ? 120 : null),
      (price) => (price === 30340.5 ? 220 : null),
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: "a",
      x: 120,
      y: 220,
      fillColor: "#ef4444",
      strokeColor: "#f85149",
    });
    expect(projected[0].radius).toBeGreaterThan(8);
  });

  it("formats hover tooltip with family and MNQ price", () => {
    const item: EventBubbleItem = {
      id: "bubble",
      time: 100 as UTCTimestamp,
      price: 30340.13,
      tier: "MEDIUM",
      family: "sweep",
      text: "sweep at VPOC",
      strength: 0.5,
    };

    expect(eventBubbleTooltip(item)).toBe("sweep @ 30340.25 - sweep at VPOC");
  });

  it("collapses same-timestamp events into strictly-ascending unique anchor data", () => {
    // Minute-bucketed signals legitimately share a timestamp; setData rejects
    // non-unique / non-ascending times, which previously crashed the chart.
    const items: EventBubbleItem[] = [
      { id: "c", time: 200 as UTCTimestamp, price: 30350, tier: null, family: "sweep", text: "c", strength: 0.3 },
      { id: "a", time: 100 as UTCTimestamp, price: 30340, tier: null, family: "sweep", text: "a", strength: 0.3 },
      { id: "b", time: 100 as UTCTimestamp, price: 30342, tier: "HIGH", family: "iceberg", text: "b", strength: 0.7 },
    ];

    const anchor = anchorSeriesData(items);

    expect(anchor.map((d) => d.time)).toEqual([100, 200]);
    // strictly ascending + unique
    for (let i = 1; i < anchor.length; i++) {
      expect(anchor[i].time).toBeGreaterThan(anchor[i - 1].time);
    }
  });

  it("returns empty anchor data for no items", () => {
    expect(anchorSeriesData([])).toEqual([]);
  });

  it("expands autoscale around event prices", () => {
    const primitive = new EventBubblePrimitive();
    primitive.setItems([
      {
        id: "low",
        time: 100 as UTCTimestamp,
        price: 30340,
        tier: "MEDIUM",
        family: "sweep",
        text: "low",
        strength: 0.2,
      },
      {
        id: "high",
        time: 101 as UTCTimestamp,
        price: 30350,
        tier: "HIGH",
        family: "iceberg",
        text: "high",
        strength: 0.8,
      },
    ]);

    expect(primitive.autoscaleInfo()).toEqual({
      priceRange: {
        minValue: 30339.6,
        maxValue: 30350.4,
      },
    });
  });
});
