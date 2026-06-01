import { describe, expect, it, vi } from "vitest";
import { createDashboardStore } from "./store";
import { initialState } from "./types";
import type { RealtimeMessage } from "@contracts/realtime/events";

function priceFrame(seq: number, price: number): { kind: "message"; raw: RealtimeMessage; nowMs: number } {
  return {
    kind: "message",
    nowMs: 1_000 + seq,
    raw: {
      type: "event",
      seq,
      ts_ns: 1_780_000_000_000_000_000 + seq,
      payload: {
        family: "price_tick",
        price,
        bid: price - 0.25,
        ask: price + 0.25,
        volume: 1,
        orderflow: null,
      },
    } as unknown as RealtimeMessage,
  };
}

describe("createDashboardStore", () => {
  it("starts at initialState and returns a stable reference until mutated", () => {
    const store = createDashboardStore();
    const a = store.getState();
    const b = store.getState();
    expect(a).toBe(b);
    expect(a.price.price).toBe(initialState().price.price);
  });

  it("notifies subscribers when a frame changes state", () => {
    const store = createDashboardStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch(priceFrame(1, 30000));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().price.price).toBe(30000);
  });

  it("does NOT notify when the reducer returns the same reference (tick-clock bail-out)", () => {
    const store = createDashboardStore();
    const listener = vi.fn();
    store.subscribe(listener);
    // tick-clock returns the same state ref -> must be a no-op (mirrors the
    // useReducer bail-out the old implementation relied on).
    store.dispatch({ kind: "tick-clock", nowMs: 5_000 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("preserves slice identity for untouched slices across a price tick", () => {
    const store = createDashboardStore();
    // Seed a snapshot-less price tick; capture the feed reference.
    store.dispatch(priceFrame(1, 30000));
    const feedRef = store.getState().feed;
    const zonesRef = store.getState().zones;
    store.dispatch(priceFrame(2, 30010));
    // The price slice changed identity; feed + zones did NOT. This is the
    // property selector-scoped subscriptions depend on.
    expect(store.getState().feed).toBe(feedRef);
    expect(store.getState().zones).toBe(zonesRef);
  });

  it("stops notifying after unsubscribe", () => {
    const store = createDashboardStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch(priceFrame(1, 30000));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch(priceFrame(2, 30010));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
