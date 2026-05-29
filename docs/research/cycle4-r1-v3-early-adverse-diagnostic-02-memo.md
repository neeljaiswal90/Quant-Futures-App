# CYCLE4-R1-V3-EARLY-ADVERSE-DIAGNOSTIC-02 Memo

## 1. Context

PR #273 extended the held-out evidence surface so v3 early-adverse diagnostics can use entry VIX context, signed-shock context, recent signed-shock values, first-minute path summaries, and `adverse_r_at_exit`.

This ticket regenerated v3 held-out evidence with that schema and reran the early-adverse diagnostic for `regime_shock_reversion_short_v3` only.

The purpose is diagnostic: decide whether the new evidence supports a concrete future registered-inactive variant or whether more evidence/scoping is needed.

## 2. Source artifact provenance

| Item | Value |
|---|---|
| Substrate | `origin/main@8ec1b307031f92f24c11e55ec87230df6d6af86f` or later |
| Strategy | `regime_shock_reversion_short_v3` |
| Lock manifest | `artifacts/strategy-selection/qfa611-cycle4-r1-v3-early-adverse-diagnostic-02-parameter-locks.json` |
| Lock manifest SHA-256 | `cf12fd8a109f310efac23931d9bc81c58e4a86651d4e1c2d6df1ba5e5057a497` |
| Metadata | `config/research/cycle4-r1-v3-early-adverse-diagnostic-02-metadata.json` |
| Metadata SHA-256 | `f0426b25be87c51d6b0450be572fd472acb238447c1fdb4d937fc54ff9533a55` |
| Held-out artifact | `artifacts/held-out-validation/cycle4-r1-v3-early-adverse-diagnostic-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json` |
| Held-out artifact SHA-256 | `acc2ee2f27e08fab09bf0c21cbce5f409b86633a4df51782357a07b565e3476f` |

The diagnostic JSON and Markdown are derived only from the regenerated PR #273-schema artifact. Prior PR #270 / #272 outputs are anchors only.

## 3. Anchor reconciliation

| Anchor | Expected | Actual | Status |
|---|---:|---:|---|
| Total trades | 889 | 889 | matched |
| Max-adverse-R fail-safes | 245 | 245 | matched |
| Target exits | 259 | 259 | matched |
| Stop-loss exits | 363 | 363 | matched |
| Spread fail-safes | 17 | 17 | matched |
| Session-close exits | 5 | 5 | matched |
| Total net PnL cents | -102600 | -102600 | matched |

All regenerated trades are standard single-contract v3 replay with `entry_quantity = 1` and `exit_quantity = 1`.

## 4. Extended field availability

| Field | Population result |
|---|---|
| `vix_value` | 889 / 889 trades; 245 / 245 max-adverse; 259 / 259 target |
| `vix_fresh` | 889 / 889 trades; 245 / 245 max-adverse; 259 / 259 target |
| `vix_prior_close_percentile` | 889 / 889 trades; 245 / 245 max-adverse; 259 / 259 target |
| `signed_shock_vwap` | 889 / 889 trades; 245 / 245 max-adverse; 259 / 259 target |
| `signed_shock_vwap.value` | 889 / 889 trades; 245 / 245 max-adverse; 259 / 259 target |
| `signed_shock_vwap_recent_values` | 889 / 889 trades; 245 / 245 max-adverse; 259 / 259 target |
| First-minute path scalar fields | 438 / 889 trades; 114 / 245 max-adverse; 132 / 259 target |
| `first_minute_observed` | 889 / 889 trades as the explicit observed flag |
| `exits[].fail_safe_context.adverse_r_at_exit` | 262 fail-safe exits; 245 / 245 max-adverse |

First-minute path fields are nullable by design when a completed post-entry bar is not available within the causal 60-second window.

## 5. Negative vs positive class summary

| Class | Count | Net PnL cents | Avg PnL cents | Median hold min | Median MAE cents | Under 2 min |
|---|---:|---:|---:|---:|---:|---:|
| Max-adverse-R fail-safe | 245 | -580100 | -2367.76 | 1.0028 | -2400 | 71.02% |
| Target | 259 | 742000 | 2864.86 | 1.9998 | -400 | 51.74% |
| Stop-loss | 363 | -313150 | -862.67 | 1.9956 | -1300 | 60.33% |
| Spread fail-safe | 17 | 47650 | 2802.94 | 1.0047 | -1200 | 88.24% |
| Session close | 5 | 1000 | 200 | 0.9998 | -200 | 80.00% |

The max-adverse class remains a fast adverse-movement class: short median hold, deep median MAE, and strongly negative average PnL.

## 6. Signed-shock findings

The regenerated signed-shock fields did not produce a clean pre-entry separator. The best non-empty pre-entry screen in the tested set was:

| Feature | Rule | Max-adverse captured | Targets at risk | Net vs targets only |
|---|---|---:|---:|---:|
| `signed_shock_vwap.value` | `value < 2.25` | 12 | 10 | -7850 cents |

This does not meet the variant-justification threshold. It captures too few max-adverse trades and loses enough target PnL that the net screen is negative before considering stop-loss side effects.

## 7. VIX findings

VIX value, VIX freshness, and VIX prior-close percentile are now available on every trade. In the tested threshold screens, VIX did not produce a clear pre-entry rule that captured enough max-adverse losses while preserving targets.

This supports the PR #272 read: VIX context is useful diagnostic evidence, but not sufficient alone for a registered-inactive variant recommendation.

## 8. First-minute path findings

The strongest candidate separator is early-post-entry, not pre-entry:

| Feature | Rule | Actionability | Max-adverse captured | Targets at risk | Net vs targets only | Break-even gap covered |
|---|---|---|---:|---:|---:|---:|
| `first_minute_close_pnl_cents` | `<= -400` | early-post-entry | 74 | 8 | 134800 cents | 131.38% |

This is a causal marker, not a lookahead field, because PR #273 bounds the first-minute path to the first completed post-entry bar within 60 seconds. However, using it would change management behavior after entry. It cannot be framed as an entry filter and must not be implemented without a separate management/variant design ticket.

## 9. Candidate separator findings

The diagnostic does not justify a direct pre-entry registered-inactive variant.

It does justify coordinator review of an early-post-entry management diagnostic because the first-minute close-PnL marker clears the break-even screen while risking relatively few target exits in this artifact.

This is still not a tuning authorization. The next ticket would need to specify management semantics, replay expectations, winner-filter risk, and no-authority constraints before any implementation.

## 10. Variant justification decision

Decision:

`candidate_causal_early_post_entry_management_diagnostic_may_be_justified_for_coord_review`

Basis:

The best separator is early-post-entry rather than pre-entry. Any use changes management semantics and cannot be treated as an entry filter.

## 11. Evidence gaps

- `primary_percentile` and `vxn_percentile` remain unavailable as first-class per-trade fields.
- First-minute fields are only populated when a completed post-entry bar is available inside the causal 60-second observation window.
- The current diagnostic is a screening analysis, not proof that a management intervention would survive full replay.
- Any candidate rule must be replayed as a separate registered-inactive research variant or diagnostic before tuning claims.

## 12. Recommended next ticket

Recommended next ticket:

`CYCLE4-R1-V3-FIRST-MINUTE-MANAGEMENT-DIAGNOSTIC-01`

Purpose:

Scope whether a causal first-minute adverse/close-PnL management rule is worth implementing as a registered-inactive diagnostic variant, without changing v3 directly and without granting paper/live/broker/Phase 6 authority.

## 13. Verification

Byte-stability was established for:

- parameter lock manifest
- metadata
- regenerated qfa-410b held-out artifact
- diagnostic JSON
- diagnostic Markdown

The qfa-410b command used explicit `--strategy-ids regime_shock_reversion_short_v3` and did not pass `--research-fixed-contracts 2` or any order-quantity override.

PROCESS-03 determinism is expected to show artifact/evidence-output additions only. Strategy behavior, management behavior, roster state, and runtime substrate are unchanged.

## 14. Authority caveat

This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, does not authorize Phase 6, and does not mutate `ACTIVE_STRATEGY_IDS`.
