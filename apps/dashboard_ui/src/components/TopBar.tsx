/**
 * Top bar: brand, connection status pill, and the one-time "Enable alerts"
 * gesture button (which also requests Notification permission).
 */
import { useDashboardSelector } from "../store/context";
import { useAlerts } from "../alerts/AlertProvider";
import { EndDayButton } from "./EndDayButton";

const STATUS_LABEL: Record<string, string> = {
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Reconnecting",
  closed: "Offline",
};

export function TopBar() {
  // RA-112: subscribe only to conn + schemaVersion so the top bar no longer
  // re-renders on every price tick.
  const conn = useDashboardSelector((s) => s.conn);
  const schemaVersion = useDashboardSelector((s) => s.schemaVersion);
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
