/**
 * RA-112e step 8: methodology health diagnostics strip.
 *
 * A slim, always-visible row of color-coded chips that surfaces the
 * rolling-window health of the methodology rework — exactly the metrics the
 * audit reviewer asked for (2026-06-01):
 *
 *  • cap-bind rate          — is ATR_cap dominating the σ estimator?
 *  • shelf-cross-anchor     — invariant: 0 for v3, often non-zero for v2
 *  • anchor-vs-value mix    — which auction state has been dominant?
 *  • warmup share           — how much of the window was tape-starved?
 *  • estimator divergence   — v3 RMS vs v3 quantile SUP_1 width delta
 *
 * Renders a single grey row "diagnostics: pending…" until the first
 * MethodologyHealthPayload lands. Designed to take minimal screen real estate
 * (no expansion, no tabs) so the operator can leave it on permanently.
 */
import { useDashboardSelector } from "../store/context";

export function MethodologyHealth() {
  const m = useDashboardSelector((s) => s.methodologyHealth);

  if (m == null) {
    return (
      <div className="health-strip">
        <span className="health-label">diagnostics</span>
        <span className="health-chip health-pending">pending…</span>
      </div>
    );
  }

  const capV3 = m.v3_cap_bind_rate;
  const capV3Q = m.v3_quantile_cap_bind_rate;
  const crossV3 = m.v3_shelf_cross_anchor_failure_rate;
  const crossV2 = m.v2_shelf_cross_anchor_failure_rate;
  const warmup = m.warmup_share;
  const dist = m.anchor_vs_value_distribution;
  const divergence = m.estimator_width_divergence_sup_1_ticks;

  return (
    <div
      className="health-strip"
      title={`Rolling ${m.window_seconds}s window — ${m.observation_count} compute passes, ${m.emit_count} emits (${m.emit_rate_per_minute.toFixed(1)}/min)`}
    >
      <span className="health-label">diagnostics</span>

      {/* cap-bind: RMS family is the production v3 estimator */}
      <span
        className={`health-chip ${capBindClass(capV3)}`}
        title="Fraction of v3 RMS shelves bound by the ATR_cap rather than the σ estimator. 100% means cap dominates (geometry is the cap, not σ)."
      >
        cap v3 <b>{fmtPct(capV3)}</b>
      </span>
      <span
        className={`health-chip ${capBindClass(capV3Q)}`}
        title="Same metric for the shadow-mode v3 quantile estimator. Compare against cap v3 to see whether the estimator choice changes how often the cap binds."
      >
        cap q <b>{fmtPct(capV3Q)}</b>
      </span>

      {/* shelf-cross-anchor: invariant — v3 must be 0 */}
      <span
        className={`health-chip ${crossAnchorClass(crossV3, /* v3 */ true)}`}
        title="v3 invariant: SUP_1.low == anchor, DEM_1.high == anchor. Non-zero = methodology regression. ALARM."
      >
        cross v3 <b>{fmtPct(crossV3)}</b>
      </span>
      <span
        className={`health-chip ${crossAnchorClass(crossV2, /* v3 */ false)}`}
        title="v2 legacy is anchored at VAH/VAL — diverges from the rolling tactical anchor whenever the auction migrates. High = the v2 pathology the rework fixes."
      >
        cross v2 <b>{fmtPct(crossV2)}</b>
      </span>

      {/* anchor-vs-value distribution: above / inside / below */}
      <span
        className="health-chip health-info"
        title="Share of recent compute passes in each auction-vs-value state."
      >
        a/i/b{" "}
        <b>
          {fmtSharePct(dist.above_value)}/{fmtSharePct(dist.inside_value)}/
          {fmtSharePct(dist.below_value)}
        </b>
      </span>

      {/* warmup share */}
      <span
        className={`health-chip ${warmupClass(warmup)}`}
        title="Fraction of recent passes where tape was too short for stable σ. High = a lot of warmup-flagged geometry recently."
      >
        warmup <b>{fmtPct(warmup)}</b>
      </span>

      {/* estimator divergence */}
      <span
        className="health-chip health-info"
        title="Mean (quantile_width - RMS_width) for SUP_1, in ticks. Positive = quantile estimator is wider than RMS for the same anchor."
      >
        Δq-rms <b>{fmtSignedTicks(divergence)}</b>
      </span>
    </div>
  );
}

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

function fmtSharePct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  // Two-digit display for the a/i/b chip so it stays compact.
  return `${Math.round(v * 100)}`;
}

function fmtSignedTicks(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}t`;
}

function capBindClass(rate: number | null): string {
  if (rate == null) return "health-pending";
  if (rate >= 0.9) return "health-warn";     // cap is dominating
  if (rate <= 0.05) return "health-warn";    // cap never bites — also informative
  return "health-ok";
}

function crossAnchorClass(rate: number, isV3: boolean): string {
  if (isV3) {
    // v3 invariant: failure rate must be 0. Even a tiny rate is a regression.
    return rate > 0 ? "health-alarm" : "health-ok";
  }
  // v2 is expected to fail often; we surface it but do not alarm.
  if (rate >= 0.75) return "health-info";
  if (rate >= 0.25) return "health-info";
  return "health-ok";
}

function warmupClass(rate: number): string {
  if (rate >= 0.5) return "health-warn";
  if (rate >= 0.2) return "health-info";
  return "health-ok";
}
