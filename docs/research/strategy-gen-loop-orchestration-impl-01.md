# STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01

## Determination

```text
LOOP_ORCHESTRATION_IMPL_READY_FOR_VALIDATION_HYGIENE
```

## Implementation summary

`scripts/strategy-gen/run-tier1-loop.ts` now wires the critical path:

```text
emit candidates -> lock manifest -> data split spine -> TRAIN/VALIDATION score input -> survivor manifest -> held-out gate
```

New artifacts:

| Artifact | Purpose |
|---|---|
| `in-loop-scores.json` | deterministic score ledger from TRAIN/VALIDATION metrics |
| `survivor-manifest.json` | ranked survivor set allowed to reach held-out |

New CLI flags:

| Flag | Behavior |
|---|---|
| `--in-loop-score-input <path>` | required before held-out gate |
| `--survivor-count <n>` | keeps top `n` validation-scored candidates |
| `--allow-held-out-gate` | still required for QFA-410B/QFA-611 access |

## Trial accounting behavior

The trial manifest keeps the full evaluated candidate count for deflation while rewriting `candidate_strategy_ids_gated` and `gated_candidate_count` to the survivor set. That keeps evaluation accounting honest while ensuring only scored survivors touch the sealed held-out gate.

## Authority caveat

This ticket does not run QFA-410B, QFA-611, paper trading, broker actions, Phase 6 dispatch, active roster mutation, or candidate roster mutation. It only enforces survivor selection before any future held-out gate run.
