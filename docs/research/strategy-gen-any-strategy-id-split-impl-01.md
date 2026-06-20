# STRATEGY-GEN-ANY-STRATEGY-ID-SPLIT-IMPL-01

## Determination

`STRATEGY_GEN_ANY_STRATEGY_ID_SPLIT_IMPLEMENTED`

## Purpose

This fold resolves the candidate-materialization compile blast radius discovered
during Tier-1 loop validation.

Generated candidates must be accepted by the dynamic research loop, but they
must not become mandatory keys in every static strategy map. Static maps such as
run-id abbreviations, management profiles, synthetic fixtures, and default config
paths describe the hand-authored strategy families. Generated candidates inherit
their family behavior through explicit base-strategy mapping.

## Contract change

`StrategyId` now remains the static strategy universe:

```text
ACTIVE_STRATEGY_IDS + REGISTERED_INACTIVE_STRATEGY_IDS
```

`AnyStrategyId` is the dynamic accepted universe:

```text
StrategyId + CandidateStrategyId
```

`CANDIDATE_STRATEGY_IDS` remains generated and fail-closed in the checked-in
default state.

## Runtime acceptance

Added:

```text
ANY_STRATEGY_IDS
AnyStrategyId
isAnyStrategyId(...)
parseAnyStrategyId(...)
```

Dynamic research-loop paths now use candidate-aware acceptance:

```text
QFA-410B strategy id parsing
RunSpec strategy_ids validation
strategy registry lookups
candidate/strategy-evaluation payloads
real-archive held-out execution
held-out artifact metadata/results
candidate ranking
```

## Static fallback behavior

Generated candidates resolve through their base strategy where a static family
surface is required:

```text
deriveStrategyToken(...) uses base strategy abbreviation for generated candidates
buildRunSpecFromOptions(...) uses config/strategies/_candidates/<candidate>.yaml
resolveManagementProfile(...) uses the generated candidate base strategy profile
```

This preserves deterministic lineage while avoiding per-candidate edits to
static maps.

## Guardrails

```text
no ACTIVE_STRATEGY_IDS mutation
no generated candidate roster promotion
no Phase 6 authority
no paper/live/broker authority
no management profile expansion for generated candidates
no static map enumeration requirement for generated candidate hashes
```

Generated candidates can be emitted, backtested, and selected as research
candidates. A separate promotion ticket is still required before any candidate
becomes part of a static/live roster.

## Validation

Not run in this fold.

Recommended targeted validation:

```powershell
npm run strategy-gen:emit-tier1 -- --dry-run
npx tsx scripts/strategy-gen/run-tier1-loop.ts --emit-only
npx tsc -b tsconfig.json
python -m pytest scripts/strategy-selection/_lib/tests/test_qfa611_driver.py
```

## Recommended next ticket

`STRATEGY-GEN-TIER1-LOOP-RUN-AND-REVIEW-01`

Run the loop against the intended archive surface and review emitted
candidate-selection artifacts before any promotion decision.
