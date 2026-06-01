/**
 * Tier-1 CRITICAL banner + degraded-link banner.
 *
 * The CRITICAL banner decays client-side: >50pt move from the trigger price
 * OR 30min elapsed (isBannerActive, re-evaluated on the wall-clock pulse).
 * This is presentation decay, NOT signal re-derivation.
 *
 * The degraded banner shows when heartbeat.stale is set by the server OR no
 * frame has arrived in >10s.
 */
import { useDashboard, useDashboardState } from "../store/context";
import { useNow } from "../hooks/useNow";
import { activeCritical, isDegraded } from "../store/selectors";
import { formatMnqPrice } from "../contract/render";

export function Banners() {
  // Banners legitimately depends on heartbeat (rebuilt every frame) + critical
  // + price for client-side decay, so a whole-state subscription is correct
  // here. dispatch comes from the stable api.
  const { dispatch } = useDashboard();
  const state = useDashboardState();
  const now = useNow(1000);

  const critical = activeCritical(state, now);
  const degraded = isDegraded(state, now);

  return (
    <>
      {critical && (
        <div className="banner banner-critical" role="alert">
          <span>
            <b>CRITICAL</b> — {critical.description}
            {" · trigger "}
            {formatMnqPrice(critical.triggerPrice)}
          </span>
          <button
            className="btn"
            onClick={() => dispatch({ kind: "dismiss-critical" })}
          >
            Dismiss
          </button>
        </div>
      )}
      {degraded && (
        <div className="banner banner-degraded" role="status">
          <span>
            Degraded feed —{" "}
            {state.heartbeat.stale
              ? "server reports stale capture"
              : "no data received recently"}
            . Showing last known state.
          </span>
        </div>
      )}
    </>
  );
}
