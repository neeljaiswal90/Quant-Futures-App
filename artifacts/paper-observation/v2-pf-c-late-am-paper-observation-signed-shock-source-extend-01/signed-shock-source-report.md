# V2-PF-C-LATE-AM-PAPER-OBSERVATION-SIGNED-SHOCK-SOURCE-EXTEND-01 - Signed-Shock Source Report

## Determination

| Field | Value |
| --- | --- |
| determination | SIGNED_SHOCK_SOURCE_BLOCKED_MISSING_SESSION_VWAP |
| input_bounded_source_lf_sha256 | 4844a8c6dcb17bd875e0c43969eb03742df5ea961ba92c88c8c6445b388ffff2 |
| input_bar_sigma_lf_sha256 | 04f09204e4a05ffeb3e9067a1d5237ce018710e97de9bb909e6f599be48a796a |
| bounded_signed_shock_source_lf_sha256 | b6947ea56361bb8d86ee943a32bb3020edcdd164f23ab41b51aeadfc40319068 |
| closed_bars_available | 30 |
| atr14_pts_value_if_ready | 12.1162 |
| session_vwap_ready | false |
| signed_shock_values_constructed | 0 |
| recommended_next_ticket | V2-PF-C-LATE-AM-PAPER-OBSERVATION-SESSION-VWAP-SOURCE-EXTEND-01 |

## Semantics

Current repo signed-shock semantics are pinned as `(price - anchor_value) / sigma_basis_value; for signed_shock_vwap the runner passes price=quote.mid_px, anchor_type=vwap, anchor_value=context.session_vwap, sigma_basis=atr_14, sigma_basis_value=atr14Pts`.

Formula provenance: `apps/backtester/src/real-archive-execution/snapshot-features.ts:323-349; apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:1230-1241`.

Important: PR #301 sigma readiness is informational here. The signed-shock denominator is `atr_14`, not `sigma_pts`.

## Blocker

Exact `session_vwap` is not proven from the bounded PR #301 window. The ticket therefore emits no signed-shock values and does not fabricate a VWAP anchor.

Missing dependencies: `exact current-repo session_vwap anchor`, `effective RTH/session context for deciding which bars contribute to session_vwap`, `causal prior in-session bar history before the bounded PR #301 window if session_vwap did not start at the bounded window`.

## Authority caveat

Observation-day eligible: `false`. Observation-day increment: `0`. No `StrategyFeatureSnapshot`, paper runtime, `STRAT_EVAL`, `CANDIDATE`, `ORDER_INTENT`, broker/live, Phase 6, active roster, candidate roster, or observation-day authority is created.
