/**
 * Top bar: brand, connection status pill, the auction-vs-value chip
 * (RA-112e step 3), and the one-time "Enable alerts" gesture button (which
 * also requests Notification permission).
 */
import { useDashboardSelector } from "../store/context";
import { useAlerts } from "../alerts/AlertProvider";
import { EndDayButton } from "./EndDayButton";
import type { AuctionVsValueState } from "@contracts/realtime/events";

const STATUS_LABEL: Record<string, string> = {
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Reconnecting",
  closed: "Offline",
};

/**
 * RA-112e step 3: copy + color for the auction-vs-value chip.
 *
 * The chip describes a different axis from the vol-regime chip — where the
 * rolling 60-min VWAP sits vs the full-session value area. Worth a separate
 * visual so the operator can see both at a glance.
 */
const AUCTION_LABEL: Record<AuctionVsValueState, string> = {
  above_value: "AUCTION ABOVE VALUE",
  inside_value: "AUCTION INSIDE VALUE",
  below_value: "AUCTION BELOW VALUE",
  unknown: "AUCTION UNKNOWN",
};

function auctionDistanceLabel(
  state: AuctionVsValueState,
  distanceTicks: number | null,
): string {
  if (state === "inside_value" || state === "unknown") return "";
  if (distanceTicks == null || !Number.isFinite(distanceTicks)) return "";
  const ticks = Math.round(distanceTicks);
  const sign = state === "above_value" ? "+" : "-";
  return ` ${sign}${ticks}t`;
}

export function TopBar() {
  // RA-112: subscribe only to conn + schemaVersion + auction-state slices so
  // the top bar doesn't re-render on every price tick.
  const conn = useDashboardSelector((s) => s.conn);
  const schemaVersion = useDashboardSelector((s) => s.schemaVersion);
  const auctionVsValue = useDashboardSelector((s) => s.auctionVsValue);
  const auctionDistanceTicks = useDashboardSelector(
    (s) => s.auctionDistanceTicks,
  );
  const { enabled, notificationsGranted, enable } = useAlerts();

  return (
    <div className="topbar">
      <span className="brand">MNQ REALTIME</span>
      <span className={`status-pill status-${conn}`}>
        {STATUS_LABEL[conn] ?? conn}
      </span>
      {schemaVersion != null && (
        <span className="kv">
          schema v<b>{schemaVersion}</b>
        </span>
      )}
      {auctionVsValue != null && (
        <span
          className={`status-pill auction-${auctionVsValue}`}
          title="Rolling 60-min VWAP vs full-session value area"
        >
          {AUCTION_LABEL[auctionVsValue]}
          {auctionDistanceLabel(auctionVsValue, auctionDistanceTicks)}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {!enabled ? (
        <button className="btn btn-primary" onClick={() => void enable()}>
          Enable alerts
        </button>
      ) : (
        <span className="kv">
          alerts <b>on</b>
          {notificationsGranted ? " + notifications" : ""}
        </span>
      )}
      <EndDayButton />
    </div>
  );
}
