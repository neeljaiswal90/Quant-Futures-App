# Strategy generation candidate registry and trial accounting impl 01

## Status

```text
ticket = STRATEGY-GEN-CANDIDATE-REGISTRY-AND-TRIAL-ACCOUNTING-IMPL-01
determination = STRATEGY_GEN_CANDIDATE_REGISTRY_AND_TRIAL_ACCOUNTING_IMPL_READY_FOR_LOOP_EMITTER
scope_type = infrastructure_only
```

## Implemented contract

This ticket implements the first infrastructure seam needed before the
strategy-generation loop can safely emit generated candidates.

Implemented surfaces:

```text
apps/strategy_runtime/src/contracts/generated-candidate-strategy-ids.ts
apps/strategy_runtime/src/contracts/strategy-ids.ts
apps/strategy_runtime/src/strategies/registry.ts
scripts/strategy-selection/_lib/parameter_lock.py
scripts/strategy-selection/qfa-611-strategy-selection.py
scripts/strategy-selection/_lib/tests/test_qfa611_driver.py
```

## Candidate registry implementation

The runtime now has an explicit generated-candidate contract:

```text
GENERATED_CANDIDATE_STRATEGY_IDS = checked-in generated candidate ID list
GENERATED_CANDIDATE_BASE_STRATEGY_IDS = generated candidate -> static base strategy mapping
CANDIDATE_STRATEGY_IDS = GENERATED_CANDIDATE_STRATEGY_IDS
```

Default checked-in state remains empty:

```text
generated_candidate_count = 0
```

That is intentional. Unknown candidate IDs still fail closed through
`parseStrategyId(...)`; generated IDs become parseable only after the candidate
emitter updates the generated TypeScript contract.

The strategy registry now builds generated-candidate registry entries from the
static base strategy entry and maps generated candidates to the base family
generator. If a generated candidate references an unknown base strategy or a
base strategy without a generator, module initialization fails closed.

Generated candidate generator calls now wrap the base family generator:

```text
input.strategy_id passed to base generator = base_strategy_id
strategy_config.strategies[base_strategy_id] = generated candidate parameters for this call
emitted STRAT_EVAL/CANDIDATE strategy_id = generated candidate strategy_id
```

This preserves existing base-generator fail-closed checks while ensuring the
generated YAML, not the base YAML, controls the candidate decision.

## Candidate config hashing implementation

QFA-611 parameter-lock hashing now resolves generated candidate configs from:

```text
config/strategies/_candidates/<candidate_strategy_id>.yaml
```

after first checking the legacy path:

```text
config/strategies/<strategy_id>.yaml
```

This preserves the legacy path while allowing generated candidate configs to
participate in runtime parameter hash checks.

The runtime strategy config loader also resolves generated candidate YAML from
`config/strategies/_candidates/` when generated IDs are present in the generated
TypeScript contract. Candidate YAML participates in the overall strategy config
hash via normal `source_files` lineage.

## Trial-accounting implementation

QFA-611 now accepts:

```text
--trial-accounting-manifest <path>
```

When present, QFA-611 computes:

```text
effective_trial_count =
  compute_effective_trial_count(
    manual_declared_effective_trials,
    distinct_window_fingerprint_tuples,
    effective_trial_method,
  )
```

and records:

```text
effective_trial_count_source = trial_accounting_manifest
trial_accounting_manifest = canonical summary of the consumed manifest
```

Legacy non-generated QFA-611 runs remain unchanged:

```text
effective_trial_count_source = legacy_roster_or_lock_count
effective_trial_count = max(len(roster), len(parameter_locks))
```

## Fail-closed checks

The trial accounting manifest fails closed on:

```text
missing manifest file
non-object manifest root
schema_version != 1
missing or invalid effective_trial_method
missing or invalid manual_declared_effective_trials
missing or invalid distinct_window_fingerprint_tuples
missing or invalid scored_candidate_count
missing or invalid gated_candidate_count
missing or invalid constraint_invalid_candidate_count
missing or invalid search_space_hash
missing or invalid corpus_fingerprint
candidate_strategy_ids_gated mismatch with QFA-611 roster
gated_candidate_count mismatch
manual_declared_effective_trials below gated count
scored_candidate_count below gated count
effective_trial_count below roster count
unsupported effective_trial_method
```

If generated candidate IDs are registered in `CANDIDATE_STRATEGY_IDS`, QFA-611
requires `--trial-accounting-manifest` when those IDs are present in the roster.

## Explicit non-goals

This ticket does not implement:

```text
strategy sampler
candidate emitter
candidate backtest loop
generated candidate TypeScript file generation
generated candidate YAML emission
runtime output rewriting for generated candidate IDs
held-out validation run
paper/shadow run
strategy promotion
roster mutation
broker or live trading authority
```

## Recommended next ticket

```text
STRATEGY-GEN-CANDIDATE-EMITTER-SCOPE-01
```

Purpose:

```text
Define the deterministic candidate emitter that writes candidate YAML,
candidate manifest, generated-candidate-strategy-ids.ts, and
trial-accounting-manifest.json for a bounded Tier 1 search run.
```
