/**
 * RA-112e step 4d — pure trade-posture derivation from dashboard state.
 *
 * Synthesizes the auction-vs-value chip + v3 shelves + price + depth into a
 * structured "trade posture" object that the TradePosture panel renders.
 * Pure so we can unit-test every branch without React.
 *
 * The methodology this encodes (operator-locked 2026-06-01):
 *
 *   Layer 1 — STRUCTURAL  (VAH/VAL/VPOC/LVN)  — slow, session-level
 *   Layer 2 — TACTICAL    (v3 σ shelves)       — rolling 60-min reaction bands
 *   Layer 3 — EXECUTION   (MBP1: depth, OFI…) — tick-rate touch confirmation
 *
 * The panel maps these layers to a single actionable plan: bias, location,
 * direction, confluence, entry/stop/target, tape.
 */
import type {
  AuctionVsValueState,
  DepthPayload,
  Regime,
  Shelf,
  ZoneState,
} from "@contracts/realtime/events";

export const MNQ_TICK_SIZE = 0.25;

/** What kind of fade the methodology suggests at the current price location. */
export type PostureDirection =
  | "FADE_SHORT"          // price in a SUP shelf — fade up-move
  | "FADE_LONG"           // price in a DEM shelf — fade down-move
  | "AT_ANCHOR"           // price within ±2t of VWAP_w (mean-revert pivot)
  | "OUTSIDE_RANGE_UP"    // price above SUP_3 cap → exhaustion territory
  | "OUTSIDE_RANGE_DN"    // price below DEM_3 cap → capitulation territory
  | "UNKNOWN";            // missing inputs

/**
 * Trade conviction relative to the auction-vs-value bias.
 *
 *   ABOVE_VALUE bias → DEM shelves are reliable (counter-trend support);
 *                       SUP shelves fight the trend
 *   INSIDE_VALUE      → balanced; neither side preferred
 *   BELOW_VALUE bias → SUP shelves are reliable; DEM fights the trend
 */
export type PostureConviction =
  | "WITH_BIAS"     // trade direction aligns with the side the chip favors
  | "NEUTRAL"       // chip is inside_value OR unavailable
  | "AGAINST_BIAS"; // trade direction fights the trend bias

export interface ConfluenceNote {
  level: string;
  distanceTicks: number;
  /** Strong = within 4 ticks (≈1 pt on MNQ). */
  strong: boolean;
}

export interface PostureTradeLevels {
  /** The σ shelf to look for the entry inside of. */
  entryZone: { low: number; high: number };
  /** Stop sits past the NEXT tier, not just past the current one. */
  stopPrice: number;
  /** Ordered targets — first is the anchor; further are structural levels. */
  targets: { label: string; price: number }[];
}

export interface MbpReadouts {
  /** Top-of-book spread in ticks (ask - bid). null if unavailable. */
  spreadTicks: number | null;
  /** (bid_size - ask_size) / total at the top of book. [-1, 1]. */
  depthImbalance: number | null;
  /** Microprice − mid, in ticks. >0 = lean to ask (buy pressure). */
  micropriceOffsetTicks: number | null;
  /** Size-weighted top-of-book ratio for visualization (0..1 bid share). */
  bidShare: number | null;
  /**
   * Order-flow imbalance (rolling MBP1 quote-update flux). Not yet on the
   * WS contract; null in the dashboard today. Logged to disk by the touch
   * pipeline. A future ticket will surface it live.
   */
  ofi30s: number | null;
}

export interface TradePosture {
  // ----- Bias ---------------------------------------------------------
  auctionState: AuctionVsValueState | null;
  auctionDistanceTicks: number | null;
  regime: Regime | null;

  // ----- Auction range (σ3 cap bounds) -------------------------------
  anchor: number | null;
  auctionHigh: number | null;      // top of SUP_3
  auctionLow: number | null;       // bottom of DEM_3
  auctionHighCapBound: boolean;
  auctionLowCapBound: boolean;

  // ----- Current location -------------------------------------------
  currentPrice: number | null;
  containingShelf: Shelf | null;
  /** Position within the containing shelf: 0 = at low edge, 1 = at high edge. */
  positionWithinTier: number | null;
  /** Distance from VWAP_w in ticks (signed). null if either missing. */
  distanceFromAnchorTicks: number | null;

  // ----- Direction + conviction --------------------------------------
  direction: PostureDirection;
  conviction: PostureConviction;
  /** One-line plain-English rationale for the direction call. */
  reasoning: string;

  // ----- Confluence --------------------------------------------------
  confluence: ConfluenceNote | null;

  // ----- Trade levels (when direction is FADE_*) ---------------------
  tradeLevels: PostureTradeLevels | null;

  // ----- Execution layer (MBP1) -------------------------------------
  mbp: MbpReadouts;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface DerivePostureInput {
  price: number | null;
  shelves: readonly Shelf[];
  zones: readonly ZoneState[];
  depth: DepthPayload | null;
  bid: number | null;
  ask: number | null;
  auctionState: AuctionVsValueState | null;
  auctionDistanceTicks: number | null;
  regime: Regime | null;
  tickSize?: number;
}

export function deriveTradePosture(input: DerivePostureInput): TradePosture {
  const tick = input.tickSize ?? MNQ_TICK_SIZE;
  const v3 = input.shelves.filter((s) => s.family === "sigma_v3_vwap_anchor");
  const sup = v3.filter((s) => s.name.startsWith("SUP_")).sort((a, b) => a.tier - b.tier);
  const dem = v3.filter((s) => s.name.startsWith("DEM_")).sort((a, b) => a.tier - b.tier);

  // Anchor = boundary between SUP_1 and DEM_1.
  const anchor = sup[0]?.low ?? dem[0]?.high ?? null;
  const sup3 = sup.find((s) => s.tier === 3) ?? sup.at(-1) ?? null;
  const dem3 = dem.find((s) => s.tier === 3) ?? dem.at(-1) ?? null;
  const auctionHigh = sup3?.high ?? null;
  const auctionLow = dem3?.low ?? null;

  const price = input.price;
  const containingShelf = price == null ? null : findContainingShelf(price, v3);
  const positionWithinTier =
    price != null && containingShelf != null
      ? clamp01(
          (price - containingShelf.low) /
            Math.max(tick, containingShelf.high - containingShelf.low),
        )
      : null;

  const distanceFromAnchorTicks =
    price != null && anchor != null ? (price - anchor) / tick : null;

  const { direction, reasoning } = classifyDirection({
    price,
    anchor,
    auctionHigh,
    auctionLow,
    containingShelf,
    distanceFromAnchorTicks,
    tick,
  });

  const conviction = classifyConviction(direction, input.auctionState);

  const confluence =
    containingShelf != null
      ? buildConfluence(containingShelf, tick)
      : null;

  const tradeLevels =
    containingShelf != null && anchor != null && price != null
      ? buildTradeLevels({
          direction,
          containingShelf,
          sup,
          dem,
          anchor,
          zones: input.zones,
          tick,
        })
      : null;

  const mbp = deriveMbpReadouts({
    bid: input.bid,
    ask: input.ask,
    depth: input.depth,
    tick,
  });

  return {
    auctionState: input.auctionState,
    auctionDistanceTicks: input.auctionDistanceTicks,
    regime: input.regime,
    anchor,
    auctionHigh,
    auctionLow,
    auctionHighCapBound: sup3?.cap_bound ?? false,
    auctionLowCapBound: dem3?.cap_bound ?? false,
    currentPrice: price,
    containingShelf,
    positionWithinTier,
    distanceFromAnchorTicks,
    direction,
    conviction,
    reasoning,
    confluence,
    tradeLevels,
    mbp,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function findContainingShelf(price: number, shelves: readonly Shelf[]): Shelf | null {
  for (const s of shelves) {
    if (price >= s.low && price <= s.high) return s;
  }
  return null;
}

function classifyDirection(args: {
  price: number | null;
  anchor: number | null;
  auctionHigh: number | null;
  auctionLow: number | null;
  containingShelf: Shelf | null;
  distanceFromAnchorTicks: number | null;
  tick: number;
}): { direction: PostureDirection; reasoning: string } {
  const { price, anchor, auctionHigh, auctionLow, containingShelf, distanceFromAnchorTicks } = args;
  if (price == null || anchor == null) {
    return { direction: "UNKNOWN", reasoning: "Missing price or anchor." };
  }
  if (auctionHigh != null && price > auctionHigh) {
    return {
      direction: "OUTSIDE_RANGE_UP",
      reasoning: "Price is above the σ3 supply cap — in exhaustion territory. Don't fade without a catalyst.",
    };
  }
  if (auctionLow != null && price < auctionLow) {
    return {
      direction: "OUTSIDE_RANGE_DN",
      reasoning: "Price is below the σ3 demand cap — in capitulation territory. Don't fade without a catalyst.",
    };
  }
  if (distanceFromAnchorTicks != null && Math.abs(distanceFromAnchorTicks) <= 2) {
    return {
      direction: "AT_ANCHOR",
      reasoning: "Price is within 2 ticks of the rolling VWAP — pivot zone, no clear fade direction.",
    };
  }
  if (containingShelf != null) {
    if (containingShelf.name.startsWith("SUP_")) {
      return {
        direction: "FADE_SHORT",
        reasoning: `Price in ${containingShelf.name} — fade-short candidate against rolling supply.`,
      };
    }
    if (containingShelf.name.startsWith("DEM_")) {
      return {
        direction: "FADE_LONG",
        reasoning: `Price in ${containingShelf.name} — fade-long candidate against rolling demand.`,
      };
    }
  }
  return {
    direction: "UNKNOWN",
    reasoning: "Price is between shelves — no v3 reaction band engaged.",
  };
}

function classifyConviction(
  direction: PostureDirection,
  auctionState: AuctionVsValueState | null,
): PostureConviction {
  if (direction === "UNKNOWN" || direction === "AT_ANCHOR") return "NEUTRAL";
  if (auctionState == null || auctionState === "inside_value" || auctionState === "unknown") {
    return "NEUTRAL";
  }
  // ABOVE_VALUE bias = bullish trend → DEM (long-side) shelves align with bias.
  // BELOW_VALUE bias = bearish trend → SUP (short-side) shelves align with bias.
  if (auctionState === "above_value") {
    if (direction === "FADE_LONG") return "WITH_BIAS";
    if (direction === "FADE_SHORT") return "AGAINST_BIAS";
  }
  if (auctionState === "below_value") {
    if (direction === "FADE_SHORT") return "WITH_BIAS";
    if (direction === "FADE_LONG") return "AGAINST_BIAS";
  }
  return "NEUTRAL";
}

function buildConfluence(shelf: Shelf, tick: number): ConfluenceNote | null {
  const level = shelf.nearest_structural_level;
  const dist = shelf.distance_to_structural_level_ticks;
  if (level == null || dist == null) return null;
  return {
    level,
    distanceTicks: dist,
    strong: dist <= 4 / tick * tick, // i.e. <= 4 ticks
  };
}

function buildTradeLevels(args: {
  direction: PostureDirection;
  containingShelf: Shelf;
  sup: Shelf[];
  dem: Shelf[];
  anchor: number;
  zones: readonly ZoneState[];
  tick: number;
}): PostureTradeLevels | null {
  const { direction, containingShelf, sup, dem, anchor, zones, tick } = args;
  if (direction !== "FADE_SHORT" && direction !== "FADE_LONG") return null;
  const entryZone = { low: containingShelf.low, high: containingShelf.high };
  const tierIndex = sup.indexOf(containingShelf) + 1; // 1-based
  // Stop placement: above NEXT tier high (for short) or below NEXT tier low (for long).
  let stopPrice: number;
  const buffer = 4 * tick; // 4-tick buffer beyond the next tier
  if (direction === "FADE_SHORT") {
    const nextTier = sup.find((s) => s.tier === containingShelf.tier + 1);
    stopPrice = (nextTier?.high ?? containingShelf.high) + buffer;
  } else {
    const nextTier = dem.find((s) => s.tier === containingShelf.tier + 1);
    stopPrice = (nextTier?.low ?? containingShelf.low) - buffer;
  }
  // Targets: ladder anchor → opposite σ1 → nearest structural level beyond.
  const oppositeShelf =
    direction === "FADE_SHORT"
      ? dem.find((s) => s.tier === 1)
      : sup.find((s) => s.tier === 1);
  const targets: { label: string; price: number }[] = [
    { label: "T1 anchor (VWAP_w)", price: anchor },
  ];
  if (oppositeShelf) {
    const mid = (oppositeShelf.low + oppositeShelf.high) / 2;
    targets.push({
      label: `T2 ${oppositeShelf.name} mid`,
      price: mid,
    });
  }
  // Third target: structural extreme on the trade side.
  const structuralKey = direction === "FADE_SHORT" ? "val" : "vah";
  const struct = zones.find((z) => z.kind === structuralKey);
  if (struct) {
    targets.push({
      label: `T3 ${struct.kind.toUpperCase()} ${struct.price.toFixed(0)}`,
      price: struct.price,
    });
  }
  void tierIndex;
  return { entryZone, stopPrice, targets };
}

function deriveMbpReadouts(args: {
  bid: number | null;
  ask: number | null;
  depth: DepthPayload | null;
  tick: number;
}): MbpReadouts {
  const { bid, ask, depth, tick } = args;
  const spreadTicks =
    bid != null && ask != null && Number.isFinite(ask - bid)
      ? (ask - bid) / tick
      : null;
  const topBid = depth?.bid_levels?.[0];
  const topAsk = depth?.ask_levels?.[0];
  const bidSize = topBid?.size ?? null;
  const askSize = topAsk?.size ?? null;
  let depthImbalance: number | null = null;
  let bidShare: number | null = null;
  if (bidSize != null && askSize != null) {
    const total = bidSize + askSize;
    if (total > 0) {
      depthImbalance = (bidSize - askSize) / total;
      bidShare = bidSize / total;
    }
  }
  let micropriceOffsetTicks: number | null = null;
  if (
    topBid != null &&
    topAsk != null &&
    bidSize != null &&
    askSize != null &&
    bidSize + askSize > 0
  ) {
    const mid = (topBid.price + topAsk.price) / 2;
    const microprice =
      (topBid.price * askSize + topAsk.price * bidSize) / (bidSize + askSize);
    micropriceOffsetTicks = (microprice - mid) / tick;
  }
  return {
    spreadTicks,
    depthImbalance,
    micropriceOffsetTicks,
    bidShare,
    ofi30s: null,
  };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
