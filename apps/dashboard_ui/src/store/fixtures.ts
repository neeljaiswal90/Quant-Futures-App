/**
 * Wire-frame fixtures for tests — mirror the RA-067 mock emitter exactly
 * (verified against `python -m contracts.realtime.mock_emitter`).
 *
 * These are deliberately plain objects (not constructed via contract classes)
 * so tests exercise the same untyped `unknown` path the socket feeds.
 */
import type { RealtimeMessage, RealtimePayload, Tier } from "@contracts/realtime/events";

let counter = 0;
function nextTsNs(): number {
  // Monotonic-ish nanosecond stamps for deterministic ordering.
  counter += 1;
  return 1_780_000_000_000_000_000 + counter * 1_000_000_000;
}

export function envelope(
  type: string,
  seq: number,
  payload: RealtimePayload,
  tier: Tier | null = null,
): RealtimeMessage {
  return {
    type: type as RealtimeMessage["type"],
    seq,
    ts_ns: nextTsNs(),
    ts_pt: "2026-05-28T23:00:00-07:00",
    tier,
    schema_version: 1,
    payload,
  };
}

export const snapshotFrame = (seq = 1): RealtimeMessage =>
  envelope("snapshot", seq, {
    family: "snapshot",
    price: 30080,
    sigma: 12.5,
    regime: "NORMAL",
    zones: [
      { id: "vpoc", kind: "vpoc", price: 30075, label: "VPOC" },
      { id: "vah", kind: "vah", price: 30120, label: "VAH" },
      { id: "val", kind: "val", price: 30030, label: "VAL" },
      { id: "sigma1_up", kind: "sigma1", price: 30092.5, label: "+1σ" },
      { id: "sigma1_dn", kind: "sigma1", price: 30067.5, label: "-1σ" },
    ],
    recent_signals: [],
    open_scenarios: [
      {
        id: "scn-long-val",
        label: "Long off VAL reclaim",
        probability: 0.55,
        target_price: 30120,
      },
    ],
  });

export const heartbeatFrame = (seq: number, stale = false): RealtimeMessage =>
  envelope("heartbeat", seq, {
    family: "heartbeat",
    server_ts_ns: nextTsNs(),
    last_capture_ts_ns: nextTsNs(),
    stale,
  });

export const criticalSignalFrame = (seq: number): RealtimeMessage =>
  envelope(
    "event",
    seq,
    {
      family: "signal",
      event_type: "confluence_stack",
      level_id: "vpoc",
      description: "CRITICAL: iceberg + absorption + sweep stacked at VPOC",
      intensity: 0.95,
      confidence: "high",
      metadata: { families: ["iceberg", "absorption", "sweep"] },
    },
    "CRITICAL",
  );

export const sweepFrame = (seq: number): RealtimeMessage =>
  envelope(
    "event",
    seq,
    {
      family: "sweep",
      price: 30085,
      direction: "up",
      ticks_cleared: 4,
      level_id: "vah",
      description: "Swept VAH by 4 ticks",
    },
    "HIGH",
  );

export const priceTickFrame = (seq: number, price: number): RealtimeMessage =>
  envelope("event", seq, {
    family: "price_tick",
    price,
    bid: price - 0.25,
    ask: price + 0.25,
    volume: 3,
  });

export const zoneUpdateFrame = (seq: number): RealtimeMessage =>
  envelope("event", seq, {
    family: "zone_update",
    zones: [{ id: "wvwap", kind: "wvwap", price: 30088, label: "W-VWAP" }],
  });

export const unknownFamilyFrame = (seq: number): RealtimeMessage =>
  envelope("event", seq, {
    family: "future_thing",
    foo: "bar",
    description: "some future family",
  } as unknown as RealtimePayload);
