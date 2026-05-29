# CYCLE4-R1-V3-EARLY-ADVERSE-DIAGNOSTIC-02

## Source artifact provenance

- Held-out artifact: `artifacts/held-out-validation/cycle4-r1-v3-early-adverse-diagnostic-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json`
- Artifact SHA-256: `acc2ee2f27e08fab09bf0c21cbce5f409b86633a4df51782357a07b565e3476f`
- Evidence hierarchy: diagnostic outputs are derived from the regenerated PR #273-schema artifact only.

## Anchor reconciliation

- Status: `matched`
- Total trades: `889`
- Max-adverse-R fail-safes: `245`
- Target exits: `259`
- Stop-loss exits: `363`
- Spread fail-safes: `17`
- Total net PnL cents: `-102600`

## Class summaries

| Class | Count | Net PnL cents | Avg PnL cents | Median hold min | Median MAE cents | First-minute observed |
|---|---:|---:|---:|---:|---:|---:|
| max_adverse_r | 245 | -580100 | -2367.76 | 1.0028 | -2400 | 46.53% |
| target | 259 | 742000 | 2864.86 | 1.9998 | -400 | 50.97% |
| stop_loss | 363 | -313150 | -862.67 | 1.9956 | -1300 | 49.86% |
| spread_fail_safe | 17 | 47650 | 2802.94 | 1.0047 | -1200 | 52.94% |
| session_close | 5 | 1000 | 200 | 0.9998 | -200 | 40% |

## Top candidate separators

| Feature | Rule | Actionability | Max-adverse captured | Targets at risk | Net vs targets only cents | Confidence |
|---|---|---|---:|---:|---:|---|
| first_minute_close_pnl_cents | first_minute_close_pnl <= -400 | early-post-entry | 74 | 8 | 134800 | diagnostic-only; causal but would change management semantics |
| first_minute_close_pnl_cents | first_minute_close_pnl <= -800 | early-post-entry | 66 | 4 | 128900 | diagnostic-only; causal but would change management semantics |
| first_minute_close_pnl_cents | first_minute_close_pnl <= -1200 | early-post-entry | 49 | 2 | 111500 | diagnostic-only; causal but would change management semantics |
| first_minute_max_adverse_excursion_cents | first_minute_MAE <= -2000 | early-post-entry | 39 | 1 | 102950 | diagnostic-only; causal but would change management semantics |
| first_minute_max_adverse_excursion_cents | first_minute_MAE <= -1200 | early-post-entry | 63 | 10 | 100850 | diagnostic-only; causal but would change management semantics |
| first_minute_max_adverse_excursion_cents | first_minute_MAE <= -1600 | early-post-entry | 52 | 6 | 99200 | diagnostic-only; causal but would change management semantics |
| first_minute_max_adverse_excursion_cents | first_minute_MAE <= -800 | early-post-entry | 80 | 26 | 81900 | diagnostic-only; causal but would change management semantics |
| first_minute_max_adverse_excursion_cents | first_minute_MAE <= -400 | early-post-entry | 104 | 62 | 22600 | diagnostic-only; causal but would change management semantics |
| signed_shock_vwap.value | value < 1.75 | pre-entry | 0 | 0 | 0 | low; captures no max-adverse trades |
| signed_shock_vwap.value | value < 2 | pre-entry | 0 | 0 | 0 | low; captures no max-adverse trades |
| spread_bucket | spread_bucket == 0 ticks | pre-entry | 0 | 0 | 0 | low; captures no max-adverse trades |
| spread_bucket | spread_bucket == 1 tick | pre-entry | 0 | 0 | 0 | low; captures no max-adverse trades |

## Variant justification decision

- Decision: `candidate_causal_early_post_entry_management_diagnostic_may_be_justified_for_coord_review`
- Basis: best separator is early-post-entry rather than pre-entry; any use changes management semantics and cannot be treated as an entry filter

## Evidence gaps

- primary_percentile and vxn_percentile remain unavailable as first-class per-trade fields
- first-minute fields are causal but not pre-entry; any use would require a separate management/variant design ticket
- candidate separators are diagnostic screens, not causal proof and not authorization

## Authority caveat

This diagnostic does not activate v3, does not authorize paper observation, does not authorize broker/live dispatch, does not authorize Phase 6, and does not mutate ACTIVE_STRATEGY_IDS.
