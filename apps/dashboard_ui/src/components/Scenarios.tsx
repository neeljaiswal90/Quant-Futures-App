/**
 * Tier-2 active scenarios: at most 3 within +-100pt of price, priority-sorted
 * (probability, then proximity). Ranking is the pure rankScenarios selector.
 */
import { useMemo } from "react";
import { useDashboardSelector } from "../store/context";
import { rankScenarios } from "../contract/scenarios";
import { formatMnqPrice } from "../contract/render";

export function Scenarios() {
  // RA-112: subscribe to the scenarios slice + price; rank in a memo so the
  // selector returns stable references (rankScenarios builds a fresh array,
  // which would defeat useSyncExternalStore if used as the selector itself).
  const scenarioSlice = useDashboardSelector((s) => s.scenarios);
  const price = useDashboardSelector((s) => s.price.price);
  const scenarios = useMemo(
    () => rankScenarios(scenarioSlice, price, { windowPt: 100, max: 3 }),
    [scenarioSlice, price],
  );
  if (scenarios.length === 0) return null;

  return (
    <div className="panel">
      <h2>Active scenarios</h2>
      {scenarios.map((s) => (
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
        ))}
    </div>
  );
}
