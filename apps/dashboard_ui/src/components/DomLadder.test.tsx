import { describe, expect, it } from "vitest";
import type { ZoneState } from "@contracts/realtime/events";
import { depthPayload } from "../store/fixtures";
import type { FeedItem } from "../contract/render";
import {
  buildDomLadderRows,
  domLadderRadiusTicks,
  shouldRecenterDomLadder,
} from "./domLadderModel";

const NOW_MS = 1_780_000_010_000;

function zones(): ZoneState[] {
  return [
    { id: "vpoc", kind: "vpoc", price: 30090.75, label: "VPOC" },
    { id: "wvwap", kind: "wvwap", price: 30091.25, label: "W-VWAP" },
  ];
}

function icebergItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    seq: 10,
    tsNs: (NOW_MS - 60_000) * 1e6,
    tier: "HIGH",
    family: "iceberg",
    price: 30090.5,
    levelId: null,
    side: "ask",
    eventKey: "iceberg|price",
    text: "iceberg",
    strength: 0.7,
    ...overrides,
  };
}

describe("DOM ladder row model", () => {
  it("holds the center inside the hysteresis window and recenters near the edge", () => {
    expect(shouldRecenterDomLadder(30090, 30091, 20)).toBe(false);
    expect(shouldRecenterDomLadder(30090, 30094.25, 20)).toBe(true);
  });

  it("drives the visible row count from depth.n_ticks plus the small margin", () => {
    const depth = { ...depthPayload(), n_ticks: 3 };
    const rows = buildDomLadderRows({
      depth,
      centerPrice: depth.mid ?? 30090.25,
      lastPrice: 30090,
      zones: [],
      history: [],
      nowMs: NOW_MS,
    });

    expect(rows).toHaveLength(domLadderRadiusTicks(depth) * 2 + 1);
    expect(rows[0].price).toBeGreaterThan(rows.at(-1)!.price);
  });

  it("caps the visible ladder window so wide depth payloads do not scroll", () => {
    const depth = { ...depthPayload(), n_ticks: 100 };
    const rows = buildDomLadderRows({
      depth,
      centerPrice: depth.mid ?? 30090.25,
      lastPrice: 30090,
      zones: [],
      history: [],
      nowMs: NOW_MS,
    });

    expect(domLadderRadiusTicks(depth)).toBe(19);
    expect(rows).toHaveLength(39);
  });

  it("highlights the last-price row more strongly when resting size is present", () => {
    const rows = buildDomLadderRows({
      depth: depthPayload(),
      centerPrice: 30090.25,
      lastPrice: 30090,
      zones: [],
      history: [],
      nowMs: NOW_MS,
    });
    const row = rows.find((candidate) => candidate.price === 30090);

    expect(row?.isLastPrice).toBe(true);
    expect(row?.isLiveRestingPrice).toBe(true);
    expect(row?.bidSize).toBeGreaterThan(0);
  });

  it("snaps zones to tick rows", () => {
    const rows = buildDomLadderRows({
      depth: depthPayload(),
      centerPrice: 30090.25,
      lastPrice: null,
      zones: zones(),
      history: [],
      nowMs: NOW_MS,
    });

    expect(rows.find((row) => row.price === 30090.75)?.zoneLabels).toContain("VPOC");
    expect(rows.find((row) => row.price === 30091.25)?.zoneLabels).toContain("W-VWAP");
  });

  it("matches iceberg chips by rounded price and fades them with age", () => {
    const rows = buildDomLadderRows({
      depth: depthPayload(),
      centerPrice: 30090.25,
      lastPrice: null,
      zones: zones(),
      history: [
        icebergItem({ price: 30090.5, eventKey: "iceberg|fresh" }),
        icebergItem({
          price: 30090.5,
          tsNs: (NOW_MS - 9 * 60_000) * 1e6,
          eventKey: "iceberg|old",
          side: "bid",
        }),
      ],
      nowMs: NOW_MS,
    });

    const row = rows.find((candidate) => candidate.price === 30090.5);
    expect(row?.icebergOpacity).toBeGreaterThan(0.8);
  });

  it("matches iceberg chips by level_id when the price is absent", () => {
    const rows = buildDomLadderRows({
      depth: depthPayload(),
      centerPrice: 30090.25,
      lastPrice: null,
      zones: zones(),
      history: [icebergItem({ price: undefined, levelId: "vpoc" })],
      nowMs: NOW_MS,
    });

    expect(rows.find((row) => row.price === 30090.75)?.icebergOpacity).toBeGreaterThan(
      0,
    );
  });

  it("drops stale iceberg chips after the fade window", () => {
    const rows = buildDomLadderRows({
      depth: depthPayload(),
      centerPrice: 30090.25,
      lastPrice: null,
      zones: [],
      history: [
        icebergItem({
          tsNs: (NOW_MS - 11 * 60_000) * 1e6,
        }),
      ],
      nowMs: NOW_MS,
    });

    expect(rows.find((candidate) => candidate.price === 30090.5)?.icebergOpacity).toBe(
      0,
    );
  });
});
