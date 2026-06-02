/**
 * Narrowing type guards over the frozen realtime contract.
 *
 * The contract ships `isFamily()` but it returns a plain boolean (NOT a TS
 * type guard), so we author real `payload is X` guards here. Switching is on
 * `payload.family` (the discriminator) — never on the coarse envelope `type`.
 *
 * RA-050 extensibility: an unknown family is NOT an error. Guards simply
 * return false and the call site falls back to GenericPayload handling.
 */
import type {
  AbsorptionPayload,
  AuctionStatePayload,
  DepthPayload,
  ErrorPayload,
  HeartbeatPayload,
  IcebergPayload,
  MbpPulsePayload,
  MethodologyHealthPayload,
  PersistentLevelPayload,
  PriceTickPayload,
  RealtimePayload,
  SignalPayload,
  SnapshotPayload,
  SweepPayload,
  VolRegimePayload,
  ZoneUpdatePayload,
} from "@contracts/realtime/events";

export function isSignal(p: RealtimePayload): p is SignalPayload {
  return p.family === "signal";
}
export function isIceberg(p: RealtimePayload): p is IcebergPayload {
  return p.family === "iceberg";
}
export function isAbsorption(p: RealtimePayload): p is AbsorptionPayload {
  return p.family === "absorption";
}
export function isSweep(p: RealtimePayload): p is SweepPayload {
  return p.family === "sweep";
}
export function isVolRegime(p: RealtimePayload): p is VolRegimePayload {
  return p.family === "vol_regime";
}
export function isPriceTick(p: RealtimePayload): p is PriceTickPayload {
  return p.family === "price_tick";
}
export function isDepth(p: RealtimePayload): p is DepthPayload {
  return p.family === "depth";
}
export function isZoneUpdate(p: RealtimePayload): p is ZoneUpdatePayload {
  return p.family === "zone_update";
}
export function isSnapshot(p: RealtimePayload): p is SnapshotPayload {
  return p.family === "snapshot";
}
export function isHeartbeat(p: RealtimePayload): p is HeartbeatPayload {
  return p.family === "heartbeat";
}
export function isError(p: RealtimePayload): p is ErrorPayload {
  return p.family === "error";
}
export function isPersistentLevel(p: RealtimePayload): p is PersistentLevelPayload {
  return p.family === "persistent_level";
}
export function isAuctionState(p: RealtimePayload): p is AuctionStatePayload {
  return p.family === "auction_state";
}
export function isMbpPulse(p: RealtimePayload): p is MbpPulsePayload {
  return p.family === "mbp_pulse";
}
export function isMethodologyHealth(
  p: RealtimePayload,
): p is MethodologyHealthPayload {
  return p.family === "methodology_health";
}

const KNOWN = new Set<string>([
  "signal",
  "iceberg",
  "absorption",
  "sweep",
  "vol_regime",
  "price_tick",
  "depth",
  "zone_update",
  "snapshot",
  "heartbeat",
  "persistent_level",
  "auction_state",
  "mbp_pulse",
  "methodology_health",
  "error",
]);

/** True for any family we do NOT have a dedicated renderer for. */
export function isUnknownFamily(p: RealtimePayload): boolean {
  return !KNOWN.has(p.family);
}
