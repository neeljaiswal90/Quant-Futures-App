# QFA-611-Cycle3 fingerprint bump

This document records the strategy fingerprint changes between Cycle2 (PR #185 / closure memo 7dd6142) and Cycle3 (QFA-611-Cycle3, this ticket).

## Schema-derived fingerprint changes (per QFA-7xx-A2)

QFA-7xx-A2 (PR #186, merged 3b2f693) extended StrategyFeatureSnapshot with
SignedShockMeasurement, session_vwap fields, adx_14, atr_14_pts, and
overnight_return_bps. This deterministically bumps strategy fingerprints because
the snapshot schema is part of the fingerprint.

## Cycle3 active strategy fingerprints (NEW strategies from Phase B)

| strategy_id | parameter_lock_hash | first-time fingerprint_sha256 |
|---|---|---|
| vwap_overnight_reversal_long | 5f5f985ca5393a166d677934e2c92c97f7d446abb6b5ee56b72fafca632b8053 | 2f1ef3f1749fe7f0f27b744296b599eb2d1a79ee889edc9cb888ddb9c39628b2 |
| vwap_overnight_reversal_short | b44d0caaddc17da5d7a578960a236e12af6a5b8c01c7f76b1288b8f7fe7df02d | 54dbc70a9dba826f2eacf6fa8c80a0b7d0ca8b906c43625955d03e434eae6e67 |
| regime_shock_reversion_short_v2 | b66db14a2346a34b9992982450aacb3e064c6611943006573390fef8cfe94492 | aca7751f2a3b404217e9c363cd7c39a7cebd295f1806523e64687b50f5527b93 |

## REGISTERED_INACTIVE strategies (Cycle1+Cycle2 verdicts locked)

These 8 strategies are NOT in Cycle3's ACTIVE_STRATEGY_IDS, do NOT contribute
to effective_trial_count=3, and do NOT have Cycle3 held-out artifacts. Their
Cycle1/Cycle2 verdicts stand on the historical record.

- trend_pullback_long
- trend_pullback_short
- breakout_retest_long
- breakdown_retest_short
- regime_mean_reversion_long
- regime_mean_reversion_short
- liquidity_sweep_reversal_long
- liquidity_sweep_reversal_short

The generator registry continues to include all 11 strategy_ids so historical
regression tests and audit tooling can still resolve prior-cycle strategies.

## Trial accounting

effective_trial_count = 3 (was 4 in Cycle1, 8 in Cycle2)

Per CF-29 count-agnostic methodology and the Bailey/Lopez de Prado independent-
selection-round principle, each cycle's trial count is the count of strategies
tested in that cycle. The 8 inactive strategies retain their Cycle2-trial-count
verdicts; Cycle3 tests its 3 new strategies at a correspondingly lower DSR
penalty.

## Stage A lineage checks

Stage A re-ran the QFA-611 driver against the committed Cycle1 and Cycle2
evidence using explicit historical strategy subsets. The reruns were byte-
identical to the committed selection reports:

| cycle | expected sha256 | result |
|---|---|---|
| Cycle1 strategy-selection-v1.json | C3898E90B53C33F3E4E4B57E9BCA9C9F8CA79DDE7015AF9C8A7473F3FC577328 | byte-identical |
| Cycle2 strategy-selection-v2.json | 46C631FF235AC925C332802A2DF8B51F6E9EB7FAA29A2B085BCB1F92D676A5A4 | byte-identical |
