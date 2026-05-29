/**
 * Tier-5 collapsed session history: every feed-worthy event this session,
 * newest first. Collapsed by default to keep the surface calm.
 */
import { useState } from "react";
import { useDashboard } from "../store/context";

function fmtTime(tsNs: number): string {
  const d = new Date(Math.floor(tsNs / 1e6));
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function HistoryPanel() {
  const { state } = useDashboard();
  const [open, setOpen] = useState(false);
  const rows = [...state.history].reverse();

  return (
    <div className="panel">
      <h2
        className="history-toggle"
        onClick={() => setOpen((o) => !o)}
        role="button"
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Session history ({state.history.length})
      </h2>
      {open &&
        (rows.length === 0 ? (
          <p className="empty">No events yet this session.</p>
        ) : (
          rows.map((item) => (
            <div className="feed-row" key={`${item.seq}-${item.tsNs}`}>
              <span className="kv">{fmtTime(item.tsNs)}</span>
              <span className={`tier-tag tier-${item.tier ?? "none"}`}>
                {item.tier ?? item.family.slice(0, 3).toUpperCase()}
              </span>
              <span>{item.text}</span>
            </div>
          ))
        ))}
    </div>
  );
}
