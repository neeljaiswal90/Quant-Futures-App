/**
 * RA-112e step 4d — Trade Posture panel.
 *
 * Renders the deriveTradePosture() output as a structured, glance-friendly
 * checklist: bias, auction range, current location, recommended direction,
 * confluence, entry/stop/target ladder, and the live MBP1 readouts.
 *
 * Subscribes to the slices the posture depends on so panel re-renders are
 * scoped — not re-renders on every price tick (price + depth selectors yield
 * scalars; nothing here re-renders on signal-feed or persistent-level updates).
 */
import { useMemo } from "react";
import { useDashboardSelector } from "../store/context";
import {
  deriveTradePosture,
  type PostureConviction,
  type PostureDirection,
  type TradePosture,
} from "../contract/tradePosture";
import { formatMnqPrice } from "../contract/render";

const DIRECTION_LABEL: Record<PostureDirection, string> = {
  FADE_SHORT: "FADE SHORT",
  FADE_LONG: "FADE LONG",
  AT_ANCHOR: "AT ANCHOR",
  OUTSIDE_RANGE_UP: "OUTSIDE σ3 (UP)",
  OUTSIDE_RANGE_DN: "OUTSIDE σ3 (DOWN)",
  UNKNOWN: "—",
};

const DIRECTION_CLASS: Record<PostureDirection, string> = {
  FADE_SHORT: "posture-dir-short",
  FADE_LONG: "posture-dir-long",
  AT_ANCHOR: "posture-dir-neutral",
  OUTSIDE_RANGE_UP: "posture-dir-warn",
  OUTSIDE_RANGE_DN: "posture-dir-warn",
  UNKNOWN: "posture-dir-neutral",
};

const CONVICTION_LABEL: Record<PostureConviction, string> = {
  WITH_BIAS: "with bias ✓",
  NEUTRAL: "neutral",
  AGAINST_BIAS: "against bias ⚠",
};

const CONVICTION_CLASS: Record<PostureConviction, string> = {
  WITH_BIAS: "posture-conv-good",
  NEUTRAL: "posture-conv-neutral",
  AGAINST_BIAS: "posture-conv-warn",
};

function fmtTicks(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}t`;
}

function fmtSignedTicks(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}t`;
}

function fmtPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatMnqPrice(value);
}

function fmtImbalance(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

export function TradePosture() {
  const price = useDashboardSelector((s) => s.price.price);
  const bid = useDashboardSelector((s) => s.price.bid);
  const ask = useDashboardSelector((s) => s.price.ask);
  const shelves = useDashboardSelector((s) => s.shelves);
  const zones = useDashboardSelector((s) => s.zones);
  const depth = useDashboardSelector((s) => s.depth);
  const auctionState = useDashboardSelector((s) => s.auctionVsValue);
  const auctionDistanceTicks = useDashboardSelector((s) => s.auctionDistanceTicks);
  const regime = useDashboardSelector((s) => s.regime);
  // RA-112e step 5: Globex/RTH split. When the trailing window is too short
  // for stable σ (right after RTH open) the backend marks the snapshot as
  // "warmup" — render a banner so the operator doesn't trust the shelves.
  const tacticalStatus = useDashboardSelector((s) => s.tacticalStatus);
  const tacticalTapeMinutes = useDashboardSelector((s) => s.tacticalTapeMinutes);
  // RA-112e step 7: live MBP1 pulse from the realtime backend's rolling
  // feature accumulator. Same wire shape as PreTouchFeatures on the touch
  // log so the live readouts and the touch-time recordings match.
  const mbpPulse = useDashboardSelector((s) => s.mbpPulse);

  const posture: TradePosture = useMemo(
    () =>
      deriveTradePosture({
        price,
        shelves,
        zones,
        depth,
        bid,
        ask,
        auctionState,
        auctionDistanceTicks,
        regime,
        mbpPulse,
      }),
    [
      price, shelves, zones, depth, bid, ask,
      auctionState, auctionDistanceTicks, regime, mbpPulse,
    ],
  );

  if (posture.anchor == null || posture.currentPrice == null) {
    return (
      <div className="panel">
        <h2>Trade posture</h2>
        <p className="empty">Awaiting v3 shelves + price…</p>
      </div>
    );
  }

  return (
    <div className="panel posture-panel">
      <h2>Trade posture</h2>

      {/* RA-112e step 5: warmup banner. Sits above the summary so the
          operator can't read the rest without seeing it first. */}
      {tacticalStatus === "warmup" && (
        <div className="posture-warmup" role="status">
          ⚠ Tactical warm-up — trailing window only
          {tacticalTapeMinutes != null
            ? ` ${tacticalTapeMinutes.toFixed(0)}/30 min`
            : ""}{" "}
          of data. Shelves shown but σ is unstable; treat with caution until
          the window matures.
        </div>
      )}
      {tacticalStatus === "no_data" && (
        <div className="posture-warmup" role="status">
          ⚠ No v3 shelves this cycle — awaiting envelope + tape.
        </div>
      )}

      {/* Top row — bias + location summary chips */}
      <div className="posture-summary">
        <span className={`posture-chip ${DIRECTION_CLASS[posture.direction]}`}>
          {DIRECTION_LABEL[posture.direction]}
        </span>
        <span className={`posture-chip ${CONVICTION_CLASS[posture.conviction]}`}>
          {CONVICTION_LABEL[posture.conviction]}
        </span>
        {posture.confluence != null && (
          <span
            className={`posture-chip ${
              posture.confluence.strong ? "posture-conf-strong" : "posture-conf-weak"
            }`}
            title={`Nearest structural level to shelf mid: ${posture.confluence.level}`}
          >
            {posture.confluence.level.toUpperCase()} {fmtTicks(posture.confluence.distanceTicks, 0)}
            {posture.confluence.strong && " ★"}
          </span>
        )}
      </div>

      <p className="posture-reasoning">{posture.reasoning}</p>

      {/* Auction range */}
      <div className="posture-section">
        <div className="posture-section-title">Auction range</div>
        <div className="posture-kv-grid">
          <span className="kv">
            HI <b>{fmtPrice(posture.auctionHigh)}</b>
            {posture.auctionHighCapBound && <span className="posture-bound">cap</span>}
          </span>
          <span className="kv">
            anchor <b>{fmtPrice(posture.anchor)}</b>
          </span>
          <span className="kv">
            LO <b>{fmtPrice(posture.auctionLow)}</b>
            {posture.auctionLowCapBound && <span className="posture-bound">cap</span>}
          </span>
        </div>
      </div>

      {/* Current location */}
      <div className="posture-section">
        <div className="posture-section-title">Current location</div>
        <div className="posture-location-row">
          <span className="kv">
            price <b>{fmtPrice(posture.currentPrice)}</b>
          </span>
          {posture.containingShelf != null && (
            <>
              <span className="kv">
                shelf <b>{posture.containingShelf.name}</b>
              </span>
              <span className="kv" title="Position within the shelf">
                tier <b>{Math.round((posture.positionWithinTier ?? 0) * 100)}%</b>
              </span>
              <span className="kv">
                bound{" "}
                <b>
                  {posture.containingShelf.bound_source === "atr_cap" ? "cap" : "sigma"}
                </b>
              </span>
            </>
          )}
          <span className="kv">
            from anchor <b>{fmtSignedTicks(posture.distanceFromAnchorTicks, 0)}</b>
          </span>
        </div>
      </div>

      {/* Trade levels */}
      {posture.tradeLevels != null && (
        <div className="posture-section">
          <div className="posture-section-title">Levels</div>
          <div className="posture-levels">
            <div className="posture-level-row">
              <span className="posture-level-label">Entry zone</span>
              <span className="posture-level-value">
                {fmtPrice(posture.tradeLevels.entryZone.low)} –{" "}
                {fmtPrice(posture.tradeLevels.entryZone.high)}
              </span>
            </div>
            <div className="posture-level-row">
              <span className="posture-level-label">Stop</span>
              <span className="posture-level-value posture-stop">
                {fmtPrice(posture.tradeLevels.stopPrice)}
              </span>
            </div>
            {posture.tradeLevels.targets.map((t, i) => (
              <div key={i} className="posture-level-row">
                <span className="posture-level-label">{t.label}</span>
                <span className="posture-level-value posture-target">
                  {fmtPrice(t.price)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Execution layer — MBP1 readouts */}
      <div className="posture-section">
        <div className="posture-section-title">Tape (MBP1 at touch)</div>
        <div className="posture-mbp-grid">
          <span className="kv">
            spread <b>{fmtTicks(posture.mbp.spreadTicks, 0)}</b>
          </span>
          <span className="kv" title="(bid_size - ask_size) / total at the top of book">
            depth imb <b>{fmtImbalance(posture.mbp.depthImbalance)}</b>
          </span>
          <span className="kv" title="microprice - mid, in ticks">
            μ-price{" "}
            <b>{fmtSignedTicks(posture.mbp.micropriceOffsetTicks, 2)}</b>
          </span>
          <span
            className={`kv${posture.mbp.ofi30s == null ? " posture-pending" : ""}`}
            title="Rolling 30s L1 OFI (positive = buyer pressure)"
          >
            OFI 30s{" "}
            <b>{fmtSignedQuantity(posture.mbp.ofi30s)}</b>
          </span>
        </div>
      </div>
    </div>
  );
}

function fmtSignedQuantity(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : value.toFixed(0);
  return `${sign}${rounded}`;
}
