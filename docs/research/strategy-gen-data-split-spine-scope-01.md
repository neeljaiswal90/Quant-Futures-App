# STRATEGY-GEN-DATA-SPLIT-SPINE-SCOPE-01

## Determination

```text
DATA_SPLIT_SPINE_SCOPE_READY_FOR_IMPL
```

## Purpose

Define the loop data partitions before adding in-loop scoring:

| Partition | Source | Allowed use |
|---|---|---|
| `TRAIN` | corpus manifest `split=calibration` | candidate scoring, feature construction, sampler feedback |
| `VALIDATION` | corpus manifest `split=validation` | in-loop survivor selection and fold diagnostics |
| `HELD_OUT` | QFA-410B/QFA-611 artifact path | sealed until the final gate |
| `PAPER` | later acceptance path | human-gated after selection only |

## Contract

- The loop must materialize a deterministic `data-split-spine.json`.
- TRAIN/VALIDATION setup must not read held-out artifacts.
- Held-out replay or QFA-611 selection must require an explicit gate authority.
- Paper partition declaration creates no paper, broker, live, Phase 6, or roster authority.
- Missing TRAIN or VALIDATION sessions fails closed.

## Authority caveat

This scope authorizes only partition metadata and a held-out access guard. It does not authorize QFA-410B execution, QFA-611 selection, paper trading, broker access, Phase 6 dispatch, active roster mutation, or candidate roster mutation.

## Recommended implementation

```text
STRATEGY-GEN-DATA-SPLIT-SPINE-IMPL-01
```
