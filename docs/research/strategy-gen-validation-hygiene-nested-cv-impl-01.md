# STRATEGY-GEN-VALIDATION-HYGIENE-NESTED-CV-IMPL-01

## Determination

```text
VALIDATION_HYGIENE_NESTED_CV_IMPL_READY
```

## Implementation summary

Added deterministic nested-validation hygiene to the strategy-generation loop.

New module:

```text
scripts/strategy-gen/nested-validation.ts
```

New emitted artifact:

```text
artifacts/strategy-generation/<generation_run_id>/nested-validation-manifest.json
```

The manifest assigns validation sessions to round-robin folds and fails closed when there are fewer validation sessions than requested folds.

## Driver integration

`run-tier1-loop` now accepts:

```text
--nested-validation-folds <n>
```

Default:

```text
3
```

When `--in-loop-score-input` is provided, validation scores must contain at least one fold score per nested-validation fold before a candidate can survive to held-out.

## Authority caveat

This ticket creates no QFA-410B run, QFA-611 selection, paper trading, broker action, Phase 6 dispatch, active roster mutation, or candidate roster mutation. It only hardens TRAIN/VALIDATION scoring hygiene before future held-out access.
