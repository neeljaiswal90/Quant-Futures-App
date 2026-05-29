/**
 * Tier-4 price context: last price, bid/ask, sigma, and vol regime.
 *
 * This is a small text readout; it re-renders on store updates (including
 * ticks). The high-frequency rendering path that must NOT re-render is the
 * chart canvas — that one reads refs. A few-Hz text update here is fine.
 */
import { useDashboard } from "../store/context";
import { formatMnqPrice } from "../contract/render";

const REGIME_COLOR: Record<string, string> = {
  LOW: "var(--green)",
  NORMAL: "var(--muted)",
  HIGH: "var(--red)",
};

export function PriceContext() {
  const { state } = useDashboard();
  const { price, bid, ask } = state.price;

  return (
    <div className="panel">
      <h2>Price context</h2>
      <div className="price-context">
        <span className="price-big">
          {price != null ? formatMnqPrice(price) : "—"}
        </span>
        <span className="kv">
          bid <b>{bid != null ? formatMnqPrice(bid) : "—"}</b>
        </span>
        <span className="kv">
          ask <b>{ask != null ? formatMnqPrice(ask) : "—"}</b>
        </span>
        <span className="kv">
          σ <b>{state.sigma != null ? state.sigma.toFixed(2) : "—"}</b>
        </span>
        <span className="kv">
          regime{" "}
          <b style={{ color: REGIME_COLOR[state.regime ?? "NORMAL"] }}>
            {state.regime ?? "—"}
          </b>
        </span>
      </div>
    </div>
  );
}
