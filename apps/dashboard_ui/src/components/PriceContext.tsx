/**
 * Tier-4 price context: last price, bid/ask, sigma, and vol regime.
 *
 * This is a small text readout; it re-renders on price/sigma/regime updates
 * (including ticks — the price slice changes per tick, which is expected here).
 * The high-frequency rendering path that must NOT re-render is the chart
 * canvas — that one reads refs. RA-112: subscribed to the price/sigma/regime
 * slices so it no longer re-renders on depth, feed, or zone events.
 */
import { useDashboardSelector } from "../store/context";
import { formatMnqPrice } from "../contract/render";

const REGIME_COLOR: Record<string, string> = {
  LOW: "var(--green)",
  NORMAL: "var(--muted)",
  HIGH: "var(--red)",
};

export function PriceContext() {
  const priceSlice = useDashboardSelector((s) => s.price);
  const sigma = useDashboardSelector((s) => s.sigma);
  const regime = useDashboardSelector((s) => s.regime);
  const { price, bid, ask, orderflow } = priceSlice;
  const cvd = orderflow?.cvd;
  const vDelta = orderflow?.v_delta;

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
          σ <b>{sigma != null ? sigma.toFixed(2) : "—"}</b>
        </span>
        <span className="kv">
          regime{" "}
          <b style={{ color: REGIME_COLOR[regime ?? "NORMAL"] }}>
            {regime ?? "—"}
          </b>
        </span>
        <span className="kv">
          CVD <b>{cvd ? cvd.session_cvd.toLocaleString() : "—"}</b>
        </span>
        <span className="kv">
          vΔ <b>{vDelta ? vDelta.value.toLocaleString() : "—"}</b>
        </span>
        <span className="kv">
          flow <b>{orderflow?.quality ?? "—"}</b>
        </span>
      </div>
    </div>
  );
}
