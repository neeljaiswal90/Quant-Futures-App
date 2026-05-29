/**
 * Tier-2 active scenarios: at most 3 within +-100pt of price, priority-sorted
 * (probability, then proximity). Ranking is the pure rankScenarios selector.
 */
import { useDashboard } from "../store/context";
import { activeScenarios } from "../store/selectors";
import { formatMnqPrice } from "../contract/render";

export function Scenarios() {
  const { state } = useDashboard();
  const scenarios = activeScenarios(state);

  return (
    <div className="panel">
      <h2>Active scenarios</h2>
      {scenarios.length === 0 ? (
        <p className="empty">No scenarios near price.</p>
      ) : (
        scenarios.map((s) => (
          <div className="scenario" key={s.id}>
            <div>{s.label}</div>
            <div className="prob">
              {s.probability != null
                ? `${Math.round(s.probability * 100)}%`
                : "—"}
              {s.target_price != null && (
                <>
                  {" · target "}
                  {formatMnqPrice(s.target_price)}
                  {Number.isFinite(s.distancePt) &&
                    ` (${s.distancePt.toFixed(1)}pt)`}
                </>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
