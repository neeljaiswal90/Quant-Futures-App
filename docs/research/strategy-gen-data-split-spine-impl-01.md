# STRATEGY-GEN-DATA-SPLIT-SPINE-IMPL-01

## Determination

```text
DATA_SPLIT_SPINE_IMPL_READY
```

## Implementation summary

Added a deterministic data-split spine for the Tier-1 strategy-generation loop:

- `scripts/strategy-gen/data-split-spine.ts`
- `scripts/strategy-gen/data-split-spine.test.ts`
- `scripts/strategy-gen/run-tier1-loop.ts`

The loop now writes:

```text
artifacts/strategy-generation/<generation_run_id>/data-split-spine.json
```

The spine records:

| Partition | Behavior |
|---|---|
| `train` | sourced from corpus manifest `split=calibration` |
| `validation` | sourced from corpus manifest `split=validation` |
| `held_out` | sealed until explicit QFA-410B/QFA-611 gate authority |
| `paper` | declared as human-gated and not materialized |

## Held-out access guard

The loop now requires:

```text
--allow-held-out-gate
```

before running held-out replay or QFA-611 selection. Emit-only and TRAIN/VALIDATION setup remain available without the flag.

## Authority caveat

No QFA-410B run, QFA-611 selection, paper trading, broker action, Phase 6 dispatch, active roster mutation, or candidate roster mutation is authorized by this ticket. The implementation only records partition metadata and fails closed on accidental held-out access.
