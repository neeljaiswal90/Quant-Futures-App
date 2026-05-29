/**
 * Top bar: brand, connection status pill, and the one-time "Enable alerts"
 * gesture button (which also requests Notification permission).
 */
import { useDashboard } from "../store/context";
import { useAlerts } from "../alerts/AlertProvider";
import { EndDayButton } from "./EndDayButton";

const STATUS_LABEL: Record<string, string> = {
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Reconnecting",
  closed: "Offline",
};

export function TopBar() {
  const { state } = useDashboard();
  const { enabled, notificationsGranted, enable } = useAlerts();

  return (
    <div className="topbar">
      <span className="brand">MNQ REALTIME</span>
      <span className={`status-pill status-${state.conn}`}>
        {STATUS_LABEL[state.conn] ?? state.conn}
      </span>
      {state.schemaVersion != null && (
        <span className="kv">
          schema v<b>{state.schemaVersion}</b>
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
