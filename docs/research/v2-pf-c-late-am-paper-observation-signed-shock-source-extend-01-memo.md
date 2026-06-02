# V2-PF-C-LATE-AM-PAPER-OBSERVATION-SIGNED-SHOCK-SOURCE-EXTEND-01 Memo

## 1. Context

PR #301 established closed `1m` bar and `sigma_pts` readiness. This ticket checks whether the signed-shock-specific inputs can now be materialized without emitting feature snapshots or running strategy evaluation.

## 2. Input provenance

PR #301 bounded source SHA: `4844a8c6dcb17bd875e0c43969eb03742df5ea961ba92c88c8c6445b388ffff2`. PR #301 report JSON SHA: `d0715f3d2b1fce0e5a70d9f912efd04563a19f02040a2922a312f9d088b53281`. PR #301 internal bar/sigma output SHA: `04f09204e4a05ffeb3e9067a1d5237ce018710e97de9bb909e6f599be48a796a`.

## 3. Signed-shock source semantics

Current repo semantics are pinned to `apps/backtester/src/real-archive-execution/snapshot-features.ts:323-349; apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:1230-1241`: `(price - anchor_value) / sigma_basis_value; for signed_shock_vwap the runner passes price=quote.mid_px, anchor_type=vwap, anchor_value=context.session_vwap, sigma_basis=atr_14, sigma_basis_value=atr14Pts`.

## 4. Sigma versus ATR

PR #301 `sigma_pts` remains important for v2 stop/risk behavior, but it is not the signed-shock denominator. The signed-shock path uses `atr_14`. Bounded bars available: `30`; ATR14 ready: `true`; ATR14 value: `12.1162`.

## 5. Session VWAP blocker

Exact `session_vwap` is not source-proven. The bounded PR #301 window has trade records, but current repo `session_vwap` depends on effective session context and causal in-session bar history. This memo does not treat bounded-window VWAP as a substitute.

## 6. Recent-history blocker

`computeSignedShockVwapRecentValues` requires `session_vwap` and `atr_14`. ATR14 is ready, but recent signed-shock values remain blocked because `session_vwap` is not proven.

## 7. Determination

Determination: `SIGNED_SHOCK_SOURCE_BLOCKED_MISSING_SESSION_VWAP`. Signed-shock values constructed: `0`. Recent values constructed: `0`.

## 8. Recommended next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-SESSION-VWAP-SOURCE-EXTEND-01`: Pin causal session_vwap/effective-session source before signed_shock_vwap can be materialized faithfully; do not proceed to feature-builder implementation yet.

Do not recommend feature-builder implementation until signed-shock source, session-state source, regime-join source, and the feature snapshot assembly contract are all resolved.

## 9. Verification

The extractor uses the committed PR #301 bounded source only, emits compact deterministic diagnostics, enforces the artifact-size guard, and preserves LF-canonical hashes.

## 10. Authority caveat

Observation-day eligible: `false`. Observation-day increment: `0`. No `StrategyFeatureSnapshot`, paper runtime, `STRAT_EVAL`, `CANDIDATE`, `ORDER_INTENT`, broker/live, Phase 6, active roster, candidate roster, or observation-day authority is created.
