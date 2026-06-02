import { describe, expect, it } from "vitest";
import { initialState, reducer } from "./reducer";
import {
  activeCritical,
  isDegraded,
  isEmpty,
  orderedFeed,
} from "./selectors";
import {
  criticalSignalFrame,
  heartbeatFrame,
  snapshotFrame,
  sweepFrame,
} from "./fixtures";

const msg = (raw: unknown, nowMs = 1_000) =>
  ({ kind: "message", raw, nowMs }) as const;

describe("isEmpty", () => {
  it("is empty before any frame", () => {
    expect(isEmpty(initialState())).toBe(true);
  });
  it("is not empty after a snapshot", () => {
    const s = reducer(initialState(), msg(snapshotFrame(1)));
    expect(isEmpty(s)).toBe(false);
  });
});

describe("isDegraded", () => {
  it("is not degraded before the first frame", () => {
    expect(isDegraded(initialState(), 999_999)).toBe(false);
  });

  it("is degraded when the server flags heartbeat.stale", () => {
    const s = reducer(initialState(), msg(heartbeatFrame(1, true), 1_000));
    expect(isDegraded(s, 1_500)).toBe(true);
  });

  it("is degraded when no frame within FRAME_STALE_MS (raised to 25s in 2026-06-02)", () => {
    const s = reducer(initialState(), msg(snapshotFrame(1), 1_000));
    // Well past the window -> degraded.
    expect(isDegraded(s, 1_000 + 30_000)).toBe(true);
    // Still inside the window — a single missed heartbeat does NOT trip.
    expect(isDegraded(s, 1_000 + 5_000)).toBe(false);
    expect(isDegraded(s, 1_000 + 20_000)).toBe(false);
  });
});

describe("activeCritical", () => {
  it("returns the banner while near price within the time window", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1), 1_000));
    s = reducer(s, {
      kind: "raise-critical",
      critical: {
        seq: 2,
        triggerPrice: 30080,
        description: "critical",
        raisedAtMs: 2_000,
      },
    });
    expect(activeCritical(s, 3_000)).not.toBeNull();
  });

  it("drops the banner after a >50pt move", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1), 1_000)); // price 30080
    s = reducer(s, {
      kind: "raise-critical",
      critical: {
        seq: 2,
        triggerPrice: 30080,
        description: "critical",
        raisedAtMs: 2_000,
      },
    });
    // push a tick 60pt away
    s = reducer(
      s,
      msg(
        {
          ...sweepFrame(3),
          payload: {
            family: "price_tick",
            price: 30150,
            bid: 30149.75,
            ask: 30150.25,
            volume: 1,
            orderflow: null,
          },
        },
        3_000,
      ),
    );
    expect(activeCritical(s, 4_000)).toBeNull();
  });
});

describe("orderedFeed", () => {
  it("returns the feed strength-then-recency ordered", () => {
    let s = reducer(initialState(), msg(snapshotFrame(1), 1_000));
    s = reducer(s, msg(sweepFrame(2), 2_000)); // HIGH
    s = reducer(s, msg(criticalSignalFrame(3), 3_000)); // CRITICAL
    const ordered = orderedFeed(s);
    expect(ordered[0].tier).toBe("CRITICAL");
  });
});
