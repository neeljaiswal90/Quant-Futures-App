# STRATEGY-GEN-INLOOP-S-SCORE-IMPL-01

## Determination

```text
INLOOP_S_SCORE_IMPL_READY_FOR_ORCHESTRATION
```

## Implementation summary

Added `scripts/strategy-gen/in-loop-s-score.ts`, a deterministic TRAIN/VALIDATION score kernel for strategy-generation survivor selection.

The score records:

| Component | Direction |
|---|---|
| HAC/annualized Sharpe | reward |
| profit factor | reward |
| expectancy | reward |
| max drawdown | penalty |
| fold dispersion | penalty |
| minimum trade floor miss | penalty |

Unit coverage lives at:

```text
apps/backtester/tests/unit/strategy-gen/in-loop-s-score.test.ts
```

## Leakage guard

The implementation rejects `held_out` and `paper` partition roles. That keeps the score usable for TRAIN/VALIDATION loop selection while preserving sealed held-out and human-gated paper boundaries.

## Authority caveat

This ticket creates no candidate promotion, QFA-611 selection, QFA-410B held-out replay, paper trading, broker action, Phase 6 dispatch, active roster mutation, or candidate roster mutation. It only provides the deterministic in-loop score primitive for later orchestration.
