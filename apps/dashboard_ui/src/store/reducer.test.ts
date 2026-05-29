import { describe, expect, it } from "vitest";
import { initialState, parseMessage, reducer } from "./reducer";
import {
  heartbeatFrame,
  priceTickFrame,
  snapshotSignal,
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

  it("retains the latest non-null orderflow across fast null ticks", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(
      s,
      msg({
        ...priceTickFrame(2, 30090.25),
        payload: {
          ...priceTickFrame(2, 30090.25).payload,
          orderflow: {
            quality: "high",
            last_trade_aggressor: "buy",
            last_trade_delta: 3,
            cvd: null,
            aggressor_windows: [],
            v_delta: null,
            footprint: null,
          },
        },
      }),
    );
    expect(s.price.orderflow?.last_trade_aggressor).toBe("buy");
    s = reducer(s, msg(priceTickFrame(3, 30091)));
    expect(s.price.price).toBe(30091);
    expect(s.price.orderflow?.last_trade_aggressor).toBe("buy");
  });
});

describe("CRITICAL banner", () => {
  it("raises a banner anchored to current price", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1), 5_000));
    s = reducer(s, {
      kind: "raise-critical",
      critical: {
        seq: 2,
        triggerPrice: 30080,
        description: "critical",
        raisedAtMs: 6_000,
      },
    });
    expect(s.critical).not.toBeNull();
    expect(s.critical?.triggerPrice).toBe(30080);
    expect(s.critical?.raisedAtMs).toBe(6_000);
  });

  it("can be dismissed", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1)));
    s = reducer(s, {
      kind: "raise-critical",
      critical: {
        seq: 2,
        triggerPrice: 30080,
        description: "critical",
        raisedAtMs: 6_000,
      },
    });
    s = reducer(s, { kind: "dismiss-critical" });
    expect(s.critical).toBeNull();
  });
});

describe("feed + history", () => {
  it("hydrates feed and history from snapshot recent_signals with signal timestamps", () => {
    const signalTs = 1_780_000_000_333_000_000;
    const s = reducer(
      initialState(),
      msg(snapshotFrame(1, [snapshotSignal("sweep_cluster", signalTs, "sweep")])),
    );

    expect(s.feed).toHaveLength(1);
    expect(s.history).toHaveLength(1);
    expect(s.feed[0].family).toBe("sweep");
    expect(s.feed[0].tsNs).toBe(signalTs);
    expect(s.feed[0].price).toBe(30080);
    expect(s.feed[0].text).toBe("sweep signal at VPOC");
  });

  it("merges repeated snapshot recent_signals idempotently", () => {
    const signal = snapshotSignal("iceberg_detected", 1_780_000_001_000_000_000, "iceberg");
    let s = reducer(initialState(), msg(snapshotFrame(1, [signal])));
    s = reducer(s, msg(snapshotFrame(1, [signal])));

    expect(s.feed).toHaveLength(1);
    expect(s.history).toHaveLength(1);
  });

  it("caps snapshot-hydrated feed at FEED_CAP", () => {
    const signals = Array.from({ length: FEED_CAP + 4 }, (_, i) =>
      snapshotSignal(
        `snapshot_signal_${i}`,
        1_780_000_000_000_000_000 + i,
        "absorption",
      ),
    );

    const s = reducer(initialState(), msg(snapshotFrame(1, signals)));

    expect(s.feed).toHaveLength(FEED_CAP);
    expect(s.history).toHaveLength(FEED_CAP + 4);
    expect(new Set(s.feed.map((item) => item.eventKey)).size).toBe(FEED_CAP);
  });

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
