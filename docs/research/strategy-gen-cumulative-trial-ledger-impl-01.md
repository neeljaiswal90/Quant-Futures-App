# STRATEGY-GEN-CUMULATIVE-TRIAL-LEDGER-IMPL-01

## Determination

`CUMULATIVE_TRIAL_LEDGER_IMPL_READY_FOR_REVIEW`

## Implementation

Added append-only cumulative trial ledger support for QFA-611.

Changed surfaces:

```text
scripts/strategy-selection/_lib/trial_ledger.py
scripts/strategy-selection/qfa-611-strategy-selection.py
scripts/strategy-selection/_lib/tests/test_qfa611_driver.py
docs/research/strategy-gen-cumulative-trial-ledger-scope-01.md
docs/research/strategy-gen-cumulative-trial-ledger-impl-01.md
```

## Behavior

QFA-611 now accepts:

```text
--cumulative-trial-ledger <path>
```

The driver rejects simultaneous use of:

```text
--trial-accounting-manifest
--cumulative-trial-ledger
```

The ledger loader computes:

```text
manual_declared_effective_trials = counted non-determinism ledger rows for gated strategies
distinct_window_fingerprint_tuples = unique window_fingerprint_tuple count
effective_trial_count = max(manual_declared_effective_trials, distinct_window_fingerprint_tuples)
```

It fails closed when a gated strategy has no counted ledger row.

## Regression proof

Added a QFA-611 regression test showing a ledger with current plus previous trials produces an `effective_trial_count` larger than the current gated roster and marks the source as:

```text
cumulative_trial_ledger
```

## Authority boundary

No strategy generation, QFA-410B run, paper trading, broker routing, roster mutation, or Phase 6 promotion is authorized by this implementation.
