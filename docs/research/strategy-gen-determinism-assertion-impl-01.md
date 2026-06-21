# STRATEGY-GEN-DETERMINISM-ASSERTION-IMPL-01

## Determination

`DETERMINISM_ASSERTION_IMPL_READY_FOR_REVIEW`

## Implementation boundary

The strategy-selection hardening layer preserves and exercises deterministic output behavior through the existing QFA-611 regression path. The driver writes canonical JSON and LF-normalized Markdown, and the regression suite runs the driver twice with the same seed and asserts byte-identical output.

This ticket does not run live strategy generation, QFA-410B, broker paths, or paper trading.

## Evidence path

The regression test `test_complete_threshold_failure_is_reject_and_deterministic` verifies:

```text
same input + same bootstrap seed => identical JSON bytes
different bootstrap seed => different JSON bytes
```

CI also runs the repository determinism replay gate.

## Remaining boundary

The full held-out two-pass assertion for generated candidates belongs in the loop-orchestration layer once `STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01` materializes the actual TRAIN/VALIDATION/HELD-OUT execution sequence.
