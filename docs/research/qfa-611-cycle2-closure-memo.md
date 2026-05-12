# QFA-611 Cycle2 Closure Memo

## Status

Phase 5 Cycle2: CLOSED. Phase 6 paper-trading dispatch: NOT AUTHORIZED.

## G3 verdict

Locked in PR #185, merge commit `a3130513813d0115e7097916b3ad51e5c4496c13`,
via `artifacts/strategy-selection/strategy-selection-v2.json`.

Cycle2 ran 8 strategies. `effective_trial_count = 8`. DSR penalty applied at
8 trials across all strategies including the Cycle1 4-strategy subset.

JSON sha256: `46C631FF235AC925C332802A2DF8B51F6E9EB7FAA29A2B085BCB1F92D676A5A4`

| Strategy | Verdict | Evidence | Reason |
|---|---|---|---|
| trend_pullback_long | REJECT | complete | three_or_more_stage1_thresholds_failed |
| trend_pullback_short | REJECT | complete | three_or_more_stage1_thresholds_failed |
| breakout_retest_long | RESEARCH_FURTHER | incomplete | sample standard deviation must be non-zero |
| breakdown_retest_short | RESEARCH_FURTHER | incomplete | sample standard deviation must be non-zero |
| regime_mean_reversion_long | REJECT | complete | three_or_more_stage1_thresholds_failed |
| regime_mean_reversion_short | RESEARCH_FURTHER | complete | one_or_two_thresholds_failed_within_20pct |
| liquidity_sweep_reversal_long | REJECT | complete | three_or_more_stage1_thresholds_failed |
| liquidity_sweep_reversal_short | REJECT | complete | three_or_more_stage1_thresholds_failed |

Summary: `advance=0`, `reject=5`, `research_further=3`,
`run_status=partial_evidence`, `execution_fragility=true`.

## Coordinator decisions

### 1. Phase 6 paper-trading dispatch: NOT AUTHORIZED

`phase_6_dispatch_authorized=false` is data-driven from the G3 verdict. No
strategy in the 8-strategy roster cleared ADR-0016 Stage 1 thresholds.
ADR-0018 (R-Protocol) walkthrough is deferred pending Phase 5 producing at
least one ADVANCE_TO_PAPER candidate.

### 2. liquidity_sweep_reversal_{long,short}: RETIRED

The pre-committed retirement clause from PR #184 fires. Both strategies are
removed from `ACTIVE_STRATEGY_IDS` in Cycle3 dispatch, when or if that ticket
lands. The retirement is a documented research-tier conclusion, not silent
removal: the L2 approximation of sweep-reversal did not convert
microstructure information into net deployable alpha on the Feb-Mar-Apr 2026
corpus under `gating_pnl_basis=net`.

This is not a refutation of microstructure as a signal class. It is a
specific finding about this particular implementation. Future sweep-reversal
hypotheses, if any, require new strategy IDs and new parameter-lock manifests
per CF-30 anti-tuning discipline.

### 3. regime_mean_reversion_short: ECONOMICALLY COMPELLING NEAR-MISS

This is the first strategy in project history that produced trade-count
viable, positive-net, statistically non-trivial economics on real archive
data: 817 trades, +$2,495 net, PF 1.288, 21% annualized return. It falls
short of ADR-0016 by 1-2 non-severe thresholds, with PF the most likely
binding fail.

The verdict is RESEARCH_FURTHER, not ADVANCE_TO_PAPER. Per Bailey/Lopez de
Prado, the visual gross economics do not yet constitute selection-grade
evidence: HAC-Sharpe, DSR, and PSR are intentionally designed to prevent
visually attractive backtests from being upgraded to selection decisions before
correcting for multiple testing, non-normal returns, and track-record
uncertainty.

The `strategy_id` and its parameter YAML stay locked. CF-30 is absolutely
binding: any follow-up hypothesis uses new strategy IDs.

### 4. ADR-0016 threshold relaxation: REJECTED

No threshold relaxation is authorized on the basis of this near-miss alone.
Adjusting ADR-0016 thresholds after seeing a near-miss is the textbook
anti-tuning trap and would invalidate the entire multiple-testing framework.
Threshold revisions require independent external methodological justification,
such as literature support for different operating points, not "the strategy
almost passed".

### 5. Cycle1 4-strategy subset: STATUS UNCHANGED

`trend_pullback_{long,short}` remain REJECT on the same grounds as Cycle1.
`breakout_retest_long` and `breakdown_retest_short` remain RESEARCH_FURTHER on
std=0 grounds: zero trades across the full Feb-Mar-Apr 2026 corpus across both
Cycle1 and Cycle2.

The Cycle2 byte-identical regression confirmation, via Stage B Cycle1-subset
stability, is the strongest possible evidence that post-Cycle1 infrastructure
work (QFA-410c, QFA-7xx-A, S3, S2, Stage A) did not introduce behavioral drift
into the existing strategies. The repeated failure is a property of the
hypotheses, not the infrastructure.

## Open Cycle3 decisions

Phase 5 Cycle2 closure does NOT auto-dispatch Cycle3. Coordinator decision is
required on each axis.

### 3a. Cycle3 GO / NO-GO

Option A: Phase 5 transitions to an indefinite research-tier deferred state.
No Cycle3 is dispatched. Phase 6 is deferred indefinitely until a major
methodology revision or evidence-window expansion justifies a new cycle.

Option B: Cycle3 is dispatched with redesigned hypothesis families per the
axes below. CF-30 discipline requires that redesigns use new strategy IDs;
existing YAMLs are not modified.

### 3b. If Cycle3 is dispatched, candidate redesign axes

Four axes are justified by Cycle2 evidence:

1. Asymmetric S3-short successor family, with a new strategy ID such as
   `regime_mean_reversion_short_v2`. Cycle2 evidence: 817 trades, +$2,495,
   PF 1.288 on the short side versus 1,100 trades, +$605, PF 1.052 on the
   long side. The 4x PnL asymmetry on 25% fewer trades suggests the
   directional thesis is fundamentally asymmetric; the symmetric Cycle2
   implementation may have suppressed signal.

2. Stronger ex-ante signed-shock filter, with a new strategy ID family such as
   `regime_mean_reversion_high_shock_*`. Larger displacement can imply cleaner
   reversion per Grant/Wolf/Yu and Monoyios/Sarno.

3. Reference-price family variation, with a new strategy ID family such as
   `regime_mean_reversion_opening_vwap_*` or `regime_mean_reversion_prior_close_*`.
   The Cycle2 lock used `session_vwap`; the Della Corte et al. 15/45/60-minute
   windows suggest opening-window or prior-close anchors may produce different
   signal-to-noise.

4. Asymmetric management, with a new strategy ID such as
   `regime_mean_reversion_short_asymmetric_mgmt`. This would use different stop,
   target, or time-stop behavior for shorts versus longs.

### 3c. Overnight-to-intraday reversal family decision

Coordinator review of Stage B raised whether an overnight-to-intraday reversal
family, in the style of Della Corte/Kosowski/Liu/Wang, should be added as a
Cycle3 hypothesis. This family is NOT the deferred `STRATEGY-1-OPENING-DRIVE`
continuation cluster, which remains INDEFINITELY_DEFERRED per CF-39/CF-40
framing.

If pursued, this would be a new strategy ID family, such as
`overnight_reversal_long`, `overnight_reversal_short`, or `vwap_overnight_*`.
The decision is to test in Cycle3 or explicitly cancel.

Coordinator decision required.

### 3d. Dormant retest-family disposition

`breakout_retest_long` and `breakdown_retest_short` have now produced zero
trades across two full QFA-611 cycles (Cycle1 + Cycle2) on the Feb-Mar-Apr
2026 corpus. Per CF-30 hygiene and the CF-43 carry-forward, dormant strategies
may be removed or redesigned between cycles.

Three options:

1. Keep on roster as-is, continuing to incur effective_trial_count cost.
2. Remove from `ACTIVE_STRATEGY_IDS` for Cycle3, reducing trial count.
3. Redesign as a new hypothesis with a new strategy ID, such as
   `breakout_retest_long_v2` with a revised gate stack.

Coordinator decision required.

## Carry-forward additions from Cycle2 experience

- CF-41: Cycle hypothesis families use new strategy IDs; no edits to existing
  YAMLs after a verdict commits to main.
- CF-42: Cycle reports must explicitly state roster size and
  effective_trial_count to prevent counterfactual interpretation drift.
- CF-43: Dormant strategies (zero-trade across full corpus across multiple
  cycles) are eligible for removal or redesign between cycles per CF-30
  hygiene.
- CF-44: A near-miss RESEARCH_FURTHER verdict does NOT justify parameter
  tuning to the same strategy ID. Any follow-up hypothesis is a NEW strategy ID
  with a new parameter-lock manifest.
- CF-45: ADR-0016 threshold revisions require independent external
  methodological justification; "the strategy almost passed" is explicitly
  insufficient.
