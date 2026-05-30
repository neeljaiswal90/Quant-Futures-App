# CYCLE4-R1-V3-MAX-ADVERSE-R-ENTRY-DIAGNOSTIC-01 Memo

## 1. Context

This diagnostic tests whether v3 max-adverse-R losses can be filtered using only pre-entry or entry-time fields. It intentionally excludes first-minute and exit-time fields from the primary rule search, because those belong to the separate management-diagnostic lane.

## 2. Source artifact provenance

- Source artifact: `artifacts/held-out-validation/cycle4-r1-v3-early-adverse-diagnostic-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json`
- Source SHA-256: `acc2ee2f27e08fab09bf0c21cbce5f409b86633a4df51782357a07b565e3476f`
- Source schema version: `1`
- Source authority: evidence only; v3 remains registered-inactive.

## 3. Anchor reconciliation

- Status: `matched`
- Total trades: `889`
- Max-adverse-R fail-safes: `245`
- Spread fail-safes: `17`
- Target exits: `259`
- Stop-loss exits: `363`
- Session-close exits: `5`
- Net PnL cents: `-102600`

## 4. Entry-field availability

| Field | Present | Missing | Coverage |
|---|---:|---:|---:|
| entry_hour_utc | 889 | 0 | 100% |
| entry_price | 889 | 0 | 100% |
| entry_ts_ns | 889 | 0 | 100% |
| queue_ahead_bucket | 889 | 0 | 100% |
| recent_shock.latest | 889 | 0 | 100% |
| regime | 889 | 0 | 100% |
| session_id | 889 | 0 | 100% |
| signed_shock_vwap | 889 | 0 | 100% |
| signed_shock_vwap.value | 889 | 0 | 100% |
| signed_shock_vwap_recent_values | 889 | 0 | 100% |
| spread_bucket | 889 | 0 | 100% |
| vix_fresh | 889 | 0 | 100% |
| vix_prior_close_percentile | 889 | 0 | 100% |
| vix_value | 889 | 0 | 100% |

## 5. Within-exit-class winner/loss accounting

Counterfactual accounting distinguishes winners and losers inside each exit class. This matters because stop-loss exits include profitable trades; they cannot be treated as uniformly bad outcomes.

| Class | Total | Winners | Losers | Net PnL cents |
|---|---:|---:|---:|---:|
| max_adverse_r | 245 | 0 | 245 | -580100 |
| session_close | 5 | 5 | 0 | 1000 |
| spread_fail_safe | 17 | 14 | 3 | 47650 |
| stop_loss | 363 | 113 | 250 | -313150 |
| target | 259 | 259 | 0 | 742000 |

## 6. Best candidates

### Best single-predicate candidate

- Rule: `vix_value < 26`
- Affected trades: `820`
- Net delta: `195150` cents
- Break-even coverage: `190.2%`
- PF proxy: `2.194194`
- Target damage: `572300` cents
- Max-adverse loss avoided: `537650` cents
- Session fragility: `not_session_fragile`

### Best two-predicate candidate

- Rule: `vix_value < 26 AND entry_hour_utc_bucket != 14`
- Affected trades: `788`
- Net delta: `212400` cents
- Break-even coverage: `207.02%`
- PF proxy: `1.956446`
- Target damage: `518000` cents
- Max-adverse loss avoided: `512600` cents
- Session fragility: `not_session_fragile`

## 7. Interpretation

The strongest entry-only candidates are broad high-VIX-style filters. They can clear the break-even target in proxy accounting, but they do so by filtering most of the strategy, including a large amount of target profit. That is not a targeted max-adverse entry filter.

The result is useful diagnostically: v3 performance appears concentrated in a smaller high-volatility subset, but the current evidence does not justify directly implementing a registered-inactive entry-filter variant without a more constrained hypothesis.

## 8. Decision

- Decision: `NO_ENTRY_VARIANT_JUSTIFIED`
- Basis: best candidate clears break-even only by filtering 788/889 trades; this is strategy suppression, not a targeted max-adverse entry filter

## 9. Recommended next step

No entry-filter variant is justified from current pre-entry evidence; keep v3 registered-inactive and avoid further entry tuning unless new evidence is introduced.

## 10. Authority caveat

No activation, paper observation, broker/live dispatch, Phase 6 authority, ACTIVE roster mutation, strategy mutation, or management-profile mutation is authorized.
