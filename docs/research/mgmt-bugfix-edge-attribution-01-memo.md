# MGMT-BUGFIX-EDGE-ATTRIBUTION-01 Memo

## 1. Context

This memo completes artifact-level dollar attribution for the v2 verdict flip caused by MGMT-BUG-FIX-02. It extends the rederivation-02 count-level matched-pair analysis without re-running either engine.

## 2. Source provenance and anchors

- Pre-fix artifact: `e985b10:artifacts/held-out-validation/cycle3/regime_shock_reversion_short_v2-feb-mar-apr-2026.json`
- Pre-fix SHA: `ef268a431980b326a138707f632470b641004243a47bc2634888fad09e928703`
- Pre-fix net PnL: `199650` cents
- Pre-fix PF ppm: `1395150`
- Post-fix artifact: `origin/main:artifacts/held-out-validation/cycle3/regime_shock_reversion_short_v2-feb-mar-apr-2026.json`
- Post-fix SHA: `b86b147aa5d3d3f7e43f0e5f7153f6516ff30125175f89660cc689c7469daed9`
- Post-fix net PnL: `-18300` cents
- Post-fix PF ppm: `973182`

## 3. Trade-availability accounting

Matched pairs: `474`; pre-only: `54`; post-only: `98`.

## 4. Exit-reason transition matrix

See the Markdown artifact for the full data table. The load-bearing transitions are target-to-fail-safe and target-to-stop-loss.

## 5. Winner-conversion finding

Target-to-fail-safe conversions: `6` trades, delta `5900` cents.
Target-to-any-loss conversions: `29` trades, delta `-63150` cents.

## 6. Path-quality determination

Classification: `MFE_MAE_SEVERITY_PROXY_ONLY`. Exact premature-cut classification is `UNAVAILABLE_IN_BASE_V1_ARTIFACT` because base v1 artifacts lack fail-safe subtype and per-trade risk fields.

## 7. Time-stop and spread attribution

Time-stop attribution: `NO_TIME_STOP_EXIT_REASON_IN_EITHER_ARTIFACT`. Spread attribution: `FAIL_SAFE_SUBTYPE_UNAVAILABLE`; entry spread buckets are reported, but max_spread_ticks subtype is unavailable.

## 8. Delta waterfall

Pre-fix net PnL `199650` cents to post-fix net PnL `-18300` cents, total delta `-217950` cents. See Markdown artifact for the waterfall table.

## 9. Improvement-target framing

Break-even gap from post-fix evidence: `18300` cents. PF 1.0 is break-even, not ADR-0016 pass; approximate PF-pass gap if gross profit unchanged is `190474.07` cents.

## 10. Routing determination

Determination: `EVIDENCE_INSUFFICIENT`.

Base v1 artifacts cannot support exact guard subtype/path-quality classification, and winner conversion is not dominant enough for proxy determination.

## 11. Recommended next step

Only extend evidence if exact subtype/premature-cut proof is decision-critical.

## 12. Authority caveat

This ticket changes no engine, strategy, parameter, roster, or authority. It attributes an already-merged verdict flip and does not re-open ADR-0024 LD-024-3 Step 4 verdict reconciliation, which remains coord+operator authority.

This ticket changes no engine, strategy, parameter, roster, or authority. It attributes an already-merged verdict flip and does not re-open the ADR-0024 LD-024-3 Step 4 verdict reconciliation, which remains coord+operator authority.
