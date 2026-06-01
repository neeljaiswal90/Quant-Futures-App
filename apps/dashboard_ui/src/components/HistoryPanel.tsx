/**
 * Tier-5 session history: every feed-worthy event this session, newest first.
 * Kept open by default so a reload never hides the tape.
 */
import { useMemo } from "react";
import { useDashboard } from "../store/context";

function fmtTime(tsNs: number): string {
  const d = new Date(Math.floor(tsNs / 1e6));
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function HistoryPanel() {
  const { state } = useDashboard();
  const rows = useMemo(() => [...state.history].reverse(), [state.history]);
  const rowNodes = useMemo(
    () =>
      rows.map((item) => (
        <div className="feed-row" key={`${item.seq}-${item.tsNs}`}>
          <span className="kv">{fmtTime(item.tsNs)}</span>
          <span className={`tier-tag tier-${item.tier ?? "none"}`}>
            {item.tier ?? item.family.slice(0, 3).toUpperCase()}
          </span>
          <span>{item.text}</span>
        </div>
      )),
    [rows],
  );

  return (
    <div className="panel">
      <h2>Session history ({state.history.length})</h2>
      {rows.length === 0 ? (
        <p className="empty">No events yet this session.</p>
      ) : (
        rowNodes
      )}
    </div>
  );
}
