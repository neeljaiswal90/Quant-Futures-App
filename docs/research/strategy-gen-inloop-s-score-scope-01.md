# STRATEGY-GEN-INLOOP-S-SCORE-SCOPE-01

## Determination

```text
INLOOP_S_SCORE_SCOPE_READY_FOR_IMPL
```

## Purpose

Define a deterministic TRAIN/VALIDATION score for strategy-generation survivor selection before any sealed held-out gate is touched.

## Score shape

```text
S = HAC-Sharpe component
  + profit-factor component
  + expectancy component
  - max-drawdown penalty
  - fold-dispersion penalty
  - trade-floor penalty
```

## Contract

- Inputs are restricted to `train` and `validation` partition roles.
- `held_out` and `paper` inputs fail closed.
- Metrics must be finite and deterministic.
- The score is an in-loop ranking signal only; it does not authorize QFA-611 selection, paper trading, broker access, Phase 6 dispatch, or roster mutation.

## Recommended implementation

```text
STRATEGY-GEN-INLOOP-S-SCORE-IMPL-01
```
