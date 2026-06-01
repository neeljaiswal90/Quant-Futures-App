import { describe, expect, it } from "vitest";
import {
  anchorSeriesData,
  EVENT_BUBBLE_ID_PREFIX,
  EventBubblePrimitive,
  EVENT_LEGEND_ITEMS,
  ICEBERG_COVERAGE_DECAY_MS,
  eventBubbleVisual,
  eventBubbleTooltip,
  feedItemToBubbleItem,
  icebergCoverageBands,
  projectBubbleItems,
  projectIcebergCoverageBands,
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
      side: "ask",
      refills: 5,
      totalConsumed: 145,
    };

    const bubble = feedItemToBubbleItem(item);

    expect(bubble).not.toBeNull();
    expect(bubble?.id).toBe(`${EVENT_BUBBLE_ID_PREFIX}iceberg|known`);
    expect(bubble?.time).toBe(1_780_000_000);
    expect(bubble?.price).toBe(30350.25);
    expect(bubble?.refills).toBe(5);
    expect(bubble?.totalConsumed).toBe(145);
  });

  it("projects time and price into chart coordinates", () => {
    const items: EventBubbleItem[] = [
      eventItem({
        id: "a",
        time: 100 as UTCTimestamp,
        price: 30340.5,
        tier: "CRITICAL",
        family: "dislocation",
        text: "dislocation",
        strength: 0.9,
        direction: "bearish",
      }),
      eventItem({
        id: "offscreen",
        time: 101 as UTCTimestamp,
        price: 1,
        tier: null,
        family: "sweep",
        text: "hidden",
        strength: 0.4,
      }),
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
      shape: "star",
      fillColor: "#f0abfc",
      strokeColor: "#f0abfc",
    });
    expect(projected[0].radius).toBeLessThan(7);
  });

  it("formats hover tooltip with family and MNQ price", () => {
    const item: EventBubbleItem = {
      id: "bubble",
      time: 100 as UTCTimestamp,
      price: 30340.13,
      tier: "MEDIUM",
      family: "sweep",
      side: null,
      direction: "up",
      text: "sweep at VPOC",
      strength: 0.5,
    };

    expect(eventBubbleTooltip(item)).toBe("sweep @ 30340.25 - sweep at VPOC");
  });

  it("collapses same-timestamp events into strictly-ascending unique anchor data", () => {
    // Minute-bucketed signals legitimately share a timestamp; setData rejects
    // non-unique / non-ascending times, which previously crashed the chart.
    const items: EventBubbleItem[] = [
      eventItem({ id: "c", time: 200 as UTCTimestamp, price: 30350, tier: null, family: "sweep", text: "c", strength: 0.3 }),
      eventItem({ id: "a", time: 100 as UTCTimestamp, price: 30340, tier: null, family: "sweep", text: "a", strength: 0.3 }),
      eventItem({ id: "b", time: 100 as UTCTimestamp, price: 30342, tier: "HIGH", family: "iceberg", text: "b", strength: 0.7 }),
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

  it("uses non-execution colors and shapes for signal families", () => {
    expect(eventBubbleVisual(eventItem({ family: "iceberg", side: "bid" }))).toMatchObject({
      shape: "diamond",
      fillColor: "#67e8f9",
      strokeColor: "#7dd3fc",
    });
    expect(eventBubbleVisual(eventItem({ family: "sweep", direction: "down" }))).toMatchObject({
      shape: "triangleDown",
      fillColor: "#c084fc",
    });

    const forbiddenExecutionColors = new Set([
      "#22c55e",
      "#3fb950",
      "#ef4444",
      "#f85149",
    ]);
    for (const item of EVENT_LEGEND_ITEMS) {
      expect(forbiddenExecutionColors.has(item.fillColor)).toBe(false);
    }
  });

  it("groups iceberg events into decaying horizontal coverage bands", () => {
    const items = [
      eventItem({
        id: "a",
        family: "iceberg",
        time: 100 as UTCTimestamp,
        price: 30350.13,
        side: "ask",
        levelId: "ask-wall",
        refills: 3,
        totalConsumed: 50,
      }),
      eventItem({
        id: "b",
        family: "iceberg",
        time: 130 as UTCTimestamp,
        price: 30350.25,
        side: "ask",
        levelId: "ask-wall",
        refills: 2,
        totalConsumed: 95,
      }),
    ];

    const [band] = icebergCoverageBands(items);

    expect(band).toMatchObject({
      id: "ask-wall",
      price: 30350.25,
      side: "ask",
      refills: 5,
      totalConsumed: 145,
      startTime: 100,
    });
    expect(Number(band?.endTime)).toBe(130 + ICEBERG_COVERAGE_DECAY_MS / 1000);
  });

  it("projects iceberg coverage with visible-time culling", () => {
    const projected = projectIcebergCoverageBands(
      [
        eventItem({
          family: "iceberg",
          time: 100 as UTCTimestamp,
          price: 30350.25,
          side: "bid",
          totalConsumed: 100,
        }),
      ],
      (time) => (Number(time) === 100 || Number(time) === 105 ? Number(time) : null),
      (price) => (price === 30350.25 ? 220 : price === 30350.375 ? 218 : 222),
      { from: 100 as UTCTimestamp, to: 105 as UTCTimestamp },
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      x: 100,
      width: 5,
      y: 218,
      fillColor: expect.stringContaining("rgba(250, 204, 21"),
    });
  });

  it("does not own chart autoscale", () => {
    const primitive = new EventBubblePrimitive();
    primitive.setItems([
      eventItem({
        id: "low",
        time: 100 as UTCTimestamp,
        price: 30340,
        tier: "MEDIUM",
        family: "sweep",
        text: "low",
        strength: 0.2,
      }),
      eventItem({
        id: "high",
        time: 101 as UTCTimestamp,
        price: 30350,
        tier: "HIGH",
        family: "iceberg",
        text: "high",
        strength: 0.8,
      }),
    ]);

    expect(primitive.autoscaleInfo()).toBeNull();
  });
});

function eventItem(overrides: Partial<EventBubbleItem> = {}): EventBubbleItem {
  return {
    id: "bubble",
    time: 100 as UTCTimestamp,
    price: 30340.25,
    tier: "MEDIUM",
    family: "sweep",
    side: null,
    direction: null,
    text: "event",
    strength: 0.5,
    ...overrides,
  };
}
