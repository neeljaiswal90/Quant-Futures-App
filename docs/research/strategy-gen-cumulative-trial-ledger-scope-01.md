# STRATEGY-GEN-CUMULATIVE-TRIAL-LEDGER-SCOPE-01

## Determination

`CUMULATIVE_TRIAL_LEDGER_SCOPE_READY_FOR_IMPL`

## Contract

Strategy-generation gates must deflate against cumulative campaign trials, not only the current emitted candidate set.

The ledger is append-only JSONL. Each counted data-touching evaluation contributes one row with:

```text
schema_version = 1
generation_run_id
campaign_id
candidate_strategy_id
window_fingerprint_tuple
corpus_fingerprint
search_space_hash
determinism_rerun
```

Rows marked `determinism_rerun=true` are preserved for audit but excluded from effective trials.

## Gate contract

QFA-611 may consume either:

```text
--trial-accounting-manifest
```

or:

```text
--cumulative-trial-ledger
```

but not both. When a cumulative ledger is supplied, QFA-611 must fail closed if the ledger has no counted rows for any gated strategy.

## Authority boundary

No strategy generation, QFA-410B run, paper trading, broker routing, roster mutation, or Phase 6 promotion is authorized by this scope.
