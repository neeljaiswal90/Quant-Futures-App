# Strategy generation candidate registry and trial accounting scope 01

## Status

```text
ticket = STRATEGY-GEN-CANDIDATE-REGISTRY-AND-TRIAL-ACCOUNTING-SCOPE-01
determination = STRATEGY_GEN_CANDIDATE_REGISTRY_AND_TRIAL_ACCOUNTING_SCOPE_READY_FOR_IMPL
scope_type = implementation_contract_only
```

## Purpose

Define the concrete implementation contract that must exist before the
strategy-generation loop can emit generated strategy candidates into the
existing backtest and QFA-611 promotion path.

This ticket resolves two design-review gaps:

```text
P1-1 = generated candidate IDs cannot be handed to the current static strategy registry unchanged
P1-2 = generation-loop trial budget is not currently wired into QFA-611 effective_trial_count
```

## Current repo constraints

The implementation must respect these existing constraints:

```text
apps/strategy_runtime/src/contracts/strategy-ids.ts
  ACTIVE_STRATEGY_IDS is static
  CANDIDATE_STRATEGY_IDS is static and currently empty
  parseStrategyId(...) rejects unknown IDs

apps/strategy_runtime/src/strategies/registry.ts
  strategy generators are registered against known StrategyId values
  generated candidate IDs do not currently map to family generators

scripts/strategy-selection/qfa-611-strategy-selection.py
  default roster parser reads ACTIVE_STRATEGY_IDS
  --strategy-ids can pass an explicit roster
  effective_trial_count is currently max(len(roster), len(parameter_locks))

scripts/strategy-selection/_lib/effective_trials.py
  compute_effective_trial_count(...) already exists
  QFA-611 does not yet consume it in the driver path
```

## Required candidate registry contract

The strategy-generation implementation must add an explicit candidate registry
handoff. Generated IDs must not rely on implicit runtime acceptance.

Preferred contract:

```text
config/strategies/_candidates/<candidate_strategy_id>.yaml
artifacts/strategy-generation/<generation_run_id>/candidate-manifest.json
apps/strategy_runtime/src/contracts/generated-candidate-strategy-ids.ts
```

The generated candidate manifest must include at minimum:

```json
{
  "schema_version": 1,
  "generation_run_id": "<stable-id>",
  "base_family": "<family>",
  "base_strategy_id": "<existing-static-strategy-id>",
  "candidate_strategy_id": "<generated-strategy-id>",
  "candidate_config_path": "config/strategies/_candidates/<candidate_strategy_id>.yaml",
  "base_generator_strategy_id": "<existing-static-strategy-id>",
  "parameter_lock_hash": "<sha256>",
  "search_space_hash": "<sha256>",
  "corpus_fingerprint": "<sha256-or-manifest-id>"
}
```

The generated TypeScript registration must be deterministic and checked in with
the candidate configs for any run that is handed to the runtime/backtester:

```text
CANDIDATE_STRATEGY_IDS includes generated candidate IDs
parseStrategyId(candidate_strategy_id) succeeds
registry maps each candidate ID to its base family generator
candidate config path is used for parameter loading and parameter-lock hashing
```

Implementation may use a generated manifest-driven registry instead of a
generated TypeScript file only if it preserves the same fail-closed behavior:

```text
unknown candidate ID = reject
candidate missing base family generator = reject
candidate config missing = reject
candidate config hash mismatch = reject
candidate ID not listed in candidate manifest = reject
```

## Required trial accounting contract

The strategy-generation implementation must emit a trial accounting manifest
before any candidate is gated on held-out evidence.

Preferred path:

```text
artifacts/strategy-generation/<generation_run_id>/trial-accounting-manifest.json
```

Required fields:

```json
{
  "schema_version": 1,
  "generation_run_id": "<stable-id>",
  "effective_trial_method": "max_of_manual_and_distinct_fingerprints",
  "manual_declared_effective_trials": 0,
  "distinct_window_fingerprint_tuples": 0,
  "scored_candidate_count": 0,
  "gated_candidate_count": 0,
  "constraint_invalid_candidate_count": 0,
  "search_space_hash": "<sha256>",
  "search_seed": "<stable-seed-or-null>",
  "candidate_strategy_ids_gated": []
}
```

QFA-611 must add a CLI input:

```text
--trial-accounting-manifest artifacts/strategy-generation/<generation_run_id>/trial-accounting-manifest.json
```

When this argument is present, QFA-611 must compute:

```text
effective_trial_count =
  compute_effective_trial_count(
    manual_declared_effective_trials,
    distinct_window_fingerprint_tuples,
    effective_trial_method,
  )
```

Fail-closed rules:

```text
generated candidate roster present and trial manifest absent = reject
manual_declared_effective_trials < gated_candidate_count = reject
effective_trial_count < len(--strategy-ids) = reject
candidate_strategy_ids_gated mismatch with --strategy-ids = reject
search_space_hash missing or malformed = reject
corpus_fingerprint missing or malformed = reject
```

Legacy QFA-611 behavior may remain for non-generated strategy-selection runs,
but generated-candidate runs must not fall back to `max(len(roster), len(locks))`.

## Required corpus declaration contract

Each search-space file must declare the exact data surface it is allowed to use.
The loader must reject a family whose required features are not present in the
declared surface.

Required shape:

```yaml
corpus:
  root: D:/qfa-cache/databento/<corpus-name>
  surface: ohlcv_1m | mbp1_trades | normalized_rth | parquet_cache
  session_scope: rth | globex | custom
  date_range: <inclusive-range-or-manifest>
  required_feature_families:
    - quote_mid
    - closed_1m_bar
    - session_vwap
    - signed_shock_vwap
  corpus_fingerprint: <sha256-or-manifest-id>
```

Examples:

```text
regime_shock_reversion_short family requires MBP/trade-derived source features
trend_pullback family may be eligible for OHLCV/structure-first source features
liquidity_sweep_reversal remains generation-ineligible under CF-30 unless a new research-tier redesign ticket explicitly reopens it
```

## Non-goals

This ticket does not implement:

```text
strategy sampler
candidate emitter
candidate backtest loop
QFA-611 code changes
new generated strategy candidates
held-out validation run
paper/shadow run
strategy promotion
roster mutation
broker or live trading authority
```

## Acceptance criteria for implementation ticket

The next implementation ticket must prove:

```text
candidate ID can be parsed by runtime without weakening unknown-ID rejection
candidate ID maps to the correct base family generator
candidate config participates in parameter-lock hashing
QFA-611 accepts explicit generated candidate roster
QFA-611 consumes trial-accounting manifest
QFA-611 reported effective_trial_count equals manifest-derived value
missing or inconsistent manifest fails closed
legacy non-generated QFA-611 path remains unchanged
```

## Recommended next ticket

```text
STRATEGY-GEN-CANDIDATE-REGISTRY-AND-TRIAL-ACCOUNTING-IMPL-01
```
