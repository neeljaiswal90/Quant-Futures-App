# ADR-0008: Walk-forward windows

## Status

Accepted

## Context

QFA-202 adds the Phase 1 walk-forward windowing foundation for later strategy replay
and out-of-sample validation work. The backtester already has deterministic RunSpec,
journal, ledger, metrics, reproducibility hashing, and CI determinism gates. Windowing
needs to be deterministic too, but it should not mutate the QFA-115 RunSpec contract or
execute strategies.

`CorpusManifestSession.session_id` is documented as usually using
`<YYYY-MM-DD>-rth`, while tests and small synthetic fixtures also use plain
`YYYY-MM-DD` keys. QFA-202 therefore treats sessions as caller-supplied deterministic
keys and validates the two currently supported conventions without discovering
sessions from disk.

## Decision

Walk-forward policy is a backtester-local input surface. It is not a new RunSpec field.
Later tickets may flow a policy through RunSpec `config_inputs` with role
`walk_forward`, but the core run identity contract remains unchanged in QFA-202.

QFA-202 implements fixed-size rolling windows only. A policy declares:

- `policy_version`
- `train_sessions`
- `validation_sessions`
- `test_sessions`
- `step_sessions`
- `min_required_sessions`

The iterator consumes a caller-supplied sorted session list. It validates that sessions
are non-empty, sorted ascending, unique, and consistently use either `YYYY-MM-DD` or
`YYYY-MM-DD-rth` keys with valid calendar dates.

All ranges use half-open semantics:

```text
[start_session, end_session)
```

The `end_session` is an explicit next-session boundary. The iterator fails closed if
there is no boundary after the test window. This avoids implicit calendar arithmetic,
timezone dependence, and ambiguous inclusive end dates.

Window IDs are deterministic strings derived from policy version, sequence, and the
train/validation/test boundaries:

```text
wf-1-<sequence>-<train_start>-<train_end>-<validation_start>-<validation_end>-<test_start>-<test_end>
```

## Consequences

QFA-301 and later validation tickets can consume `WalkForwardPlan` without depending on
filesystem discovery order, wall-clock time, locale parsing, or strategy execution.

Expanding-window, anchored-window, regime-aware, VIX-aware, and calendar-month policies
remain out of scope for QFA-202. They require explicit future design rather than
extension by implication.

The determinism CI gate remains unchanged. QFA-202 must pass it but does not modify it.
