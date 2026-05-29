import { describe, expect, it } from "vitest";
import { initialState, parseMessage, reducer } from "./reducer";
import {
  criticalSignalFrame,
  heartbeatFrame,
  priceTickFrame,
  snapshotFrame,
  sweepFrame,
  unknownFamilyFrame,
  zoneUpdateFrame,
} from "./fixtures";
import { FEED_CAP } from "./types";

const msg = (raw: unknown, nowMs = 1_000) =>
  ({ kind: "message", raw, nowMs }) as const;

describe("parseMessage", () => {
  it("accepts a well-formed envelope", () => {
    expect(parseMessage(snapshotFrame())).not.toBeNull();
  });
  it("rejects non-envelopes", () => {
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage({})).toBeNull();
    expect(parseMessage({ type: "x", seq: 1 })).toBeNull();
    expect(parseMessage({ type: "x", seq: 1, ts_ns: 1, payload: {} })).toBeNull();
  });
});

describe("snapshot application", () => {
  it("rebases price/zones/scenarios and sets lastSeq", () => {
    const s = reducer(initialState(), msg(snapshotFrame(1)));
    expect(s.lastSeq).toBe(1);
    expect(s.price.price).toBe(30080);
    expect(s.zones).toHaveLength(5);
    expect(s.scenarios).toHaveLength(1);
    expect(s.regime).toBe("NORMAL");
  });
});

describe("seq-gap detection", () => {
  it("does not flag resync on contiguous frames", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, msg(heartbeatFrame(2)));
    s = reducer(s, msg(sweepFrame(3)));
    expect(s.resyncing).toBe(false);
    expect(s.lastSeq).toBe(3);
  });

  it("flags resync when a seq is skipped", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, msg(heartbeatFrame(2)));
    // jump from 2 -> 5 (3,4 missing)
    s = reducer(s, msg(sweepFrame(5)));
    expect(s.resyncing).toBe(true);
    // payload still applied so UI is not frozen pending resync
    expect(s.lastSeq).toBe(5);
  });

  it("clears resyncing when the resync snapshot arrives", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, msg(sweepFrame(5))); // gap -> resyncing
    expect(s.resyncing).toBe(true);
    s = reducer(s, msg(snapshotFrame(1))); // re-emitted frame-0 snapshot
    expect(s.resyncing).toBe(false);
    expect(s.lastSeq).toBe(1); // snapshot rebases the sequence
  });

  it("bumps resyncEpoch on every gap so repeated gaps re-fire resync (RA-069)", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, msg(sweepFrame(5))); // gap 1
    const afterFirst = s.resyncEpoch;
    expect(afterFirst).toBeGreaterThan(0);
    // A second gap must advance the epoch even though resyncing is already true
    // (the boolean alone would be a no-op transition and wedge the resync).
    s = reducer(s, msg(sweepFrame(9))); // gap 2 (6,7,8 missing)
    expect(s.resyncing).toBe(true);
    expect(s.resyncEpoch).toBe(afterFirst + 1);
  });

  it("resync-failed clears resyncing but keeps the epoch monotonic (RA-069)", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, msg(sweepFrame(5))); // gap -> resyncing true
    const epoch = s.resyncEpoch;
    s = reducer(s, { kind: "resync-failed" });
    expect(s.resyncing).toBe(false);
    expect(s.resyncEpoch).toBe(epoch); // not reset
    // a later gap still advances the epoch and re-arms resync
    s = reducer(s, msg(sweepFrame(9)));
    expect(s.resyncEpoch).toBe(epoch + 1);
    expect(s.resyncing).toBe(true);
  });

  it("ignores duplicate / out-of-order non-snapshot frames", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, msg(sweepFrame(3)));
    const before = s;
    s = reducer(s, msg(sweepFrame(2))); // stale, < lastSeq
    expect(s.lastSeq).toBe(3);
    expect(s.feed).toEqual(before.feed); // not double-counted
  });

  it("snapshot after reconnect with reset baseline does not phantom-gap", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, msg(sweepFrame(2)));
    // simulate reconnect: conn resets lastSeq to -1
    s = reducer(s, { kind: "conn", status: "reconnecting" });
    expect(s.lastSeq).toBe(-1);
    s = reducer(s, msg(snapshotFrame(1)));
    expect(s.resyncing).toBe(false);
    expect(s.lastSeq).toBe(1);
  });
});

describe("zone_update merge-by-id", () => {
  it("adds the new zone without erasing snapshot zones", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    expect(s.zones).toHaveLength(5);
    s = reducer(s, msg(zoneUpdateFrame(2)));
    expect(s.zones).toHaveLength(6);
    expect(s.zones.find((z) => z.id === "wvwap")?.kind).toBe("wvwap");
    expect(s.zones.find((z) => z.id === "vpoc")).toBeDefined();
  });

  it("replaces a zone with the same id", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    const update = {
      ...zoneUpdateFrame(2),
      payload: {
        family: "zone_update",
        zones: [{ id: "vpoc", kind: "vpoc", price: 30099, label: "VPOC" }],
      },
    };
    s = reducer(s, msg(update));
    expect(s.zones).toHaveLength(5);
    expect(s.zones.find((z) => z.id === "vpoc")?.price).toBe(30099);
  });
});

describe("price ticks", () => {
  it("updates the price slice", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, msg(priceTickFrame(2, 30090.25)));
    expect(s.price.price).toBe(30090.25);
    expect(s.price.bid).toBe(30090);
  });
});

describe("CRITICAL banner", () => {
  it("raises a banner anchored to current price", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1), 5_000));
    s = reducer(s, msg(criticalSignalFrame(2), 6_000));
    expect(s.critical).not.toBeNull();
    expect(s.critical?.triggerPrice).toBe(30080);
    expect(s.critical?.raisedAtMs).toBe(6_000);
  });

  it("can be dismissed", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, msg(criticalSignalFrame(2)));
    s = reducer(s, { kind: "dismiss-critical" });
    expect(s.critical).toBeNull();
  });
});

describe("feed + history", () => {
  it("caps the live feed at FEED_CAP", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    for (let i = 0; i < FEED_CAP + 5; i++) {
      s = reducer(s, msg(sweepFrame(2 + i)));
    }
    expect(s.feed).toHaveLength(FEED_CAP);
    expect(s.history.length).toBeGreaterThan(FEED_CAP);
  });

  it("does not add price_tick / heartbeat / snapshot to the feed", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, msg(heartbeatFrame(2)));
    s = reducer(s, msg(priceTickFrame(3, 30081)));
    expect(s.feed).toHaveLength(0);
  });
});

describe("RA-050 extensibility", () => {
  it("does not crash on an unknown family and advances seq", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    expect(() => {
      s = reducer(s, msg(unknownFamilyFrame(2)));
    }).not.toThrow();
    expect(s.lastSeq).toBe(2);
  });
});

describe("heartbeat staleness", () => {
  it("records stale flag and frame freshness", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1), 1_000));
    s = reducer(s, msg(heartbeatFrame(2, true), 2_000));
    expect(s.heartbeat.stale).toBe(true);
    expect(s.heartbeat.lastFrameAtMs).toBe(2_000);
  });
});
