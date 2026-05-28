# CYCLE4-DEADLINE-EXPOSURE-HARNESS-01

## Purpose

This memo records a controlled diagnostic harness for the two Cycle4 v5 deadline-extension variants:

- `regime_shock_reversion_short_v5_strict_deadline`
- `regime_shock_reversion_short_v5_trail_at_deadline`

PR #255 produced valid 2MNQ informational evidence, but both variants had zero deadline-extension action exposure in the real held-out corpus. PR #256 reconciled both variants to informational `REJECT` and explicitly preserved the caveat that strict-vs-trail behavior remained unresolved under deadline-exposed positions.

This harness exposes the deadline branch directly in unit tests. It is not a selection artifact, not a held-out replay, and not an ADR-0016 verdict run.

## Fixture setup

The harness lives in `apps/strategy_runtime/tests/unit/deadline-exposure-harness.test.ts`.

It constructs a deterministic short-side synthetic candidate with:

| Field | Value |
|---|---|
| Instrument | MNQ |
| Quantity | 2 |
| Entry | 100 |
| Initial stop | 102 |
| Risk | 2 points |
| PT1 | 98 |
| PT2 | 96 |
| Open timestamp | `1700000000000000000` |

The test uses the actual registered v5 management profiles through `resolveManagementProfile(..., { allow_fallback: false })`:

| Strategy | Profile mode |
|---|---|
| `regime_shock_reversion_short_v5_strict_deadline` | `unconditional_exit` |
| `regime_shock_reversion_short_v5_trail_at_deadline` | `activate_trail` |

Positions are built through `buildTargetPositionFromCandidate` and opened with `applyInitialFillToTargetPosition`. The deadline is constructed normally from `opened_ts_ns + max_hold_minutes * 60s`; the harness does not mutate `deadline_ts_ns` directly.

## Branch-exposure scenarios

| Scenario | Profile mode | Market R at deadline | Expected action | Position state |
|---|---|---:|---|---|
| strict favorable | `unconditional_exit` | `> 0` | `TIME_STOP_EXIT` / `time_stop:deadline_reached` | closed |
| trail breakeven boundary | `activate_trail` | `0` | `ACTIVATE_TRAIL` / `time_stop:activated_trail_at_deadline` | open |
| trail favorable BE-floor | `activate_trail` | `> 0` | `ACTIVATE_TRAIL` / `time_stop:activated_trail_at_deadline` | open |
| trail favorable no-widening | `activate_trail` | `> 0` | `ACTIVATE_TRAIL` / `time_stop:activated_trail_at_deadline` | open |
| trail adverse | `activate_trail` | `< 0` | `TIME_STOP_EXIT` / `time_stop:deadline_reached` | closed |

## Short-side stop invariants

The harness asserts short-side direction signs:

- The initial short stop is above entry: `102 > 100`.
- A favorable short mark is below entry: `99 < 100`.
- The raw trail stop is `mark + distance_ticks * tick_size`.
- With `mark = 99`, `distance_ticks = 8`, and `tick_size = 0.25`, the raw trail stop is `101`.

The harness then proves both deadline trail invariants:

- BE-floor invariant: because raw short trail stop `101` is wider than break-even, the deadline activation floors the stop at entry `100`.
- No-widening invariant: if the current active stop is already tighter at `99.5`, deadline activation leaves it at `99.5` instead of widening it back to `100`.

The `unrealizedR == 0` boundary is explicit: at mark `100`, `activate_trail` activates trail and keeps the position open because ADR-0027 dispatch exits only when `unrealizedR < 0`.

## Relationship to PR #255

PR #255's real corpus evidence remains unchanged:

| Strategy | Trades | `entry_quantity=2` | `exit_quantity=2` | PT1 partial exits | PT2 final exits | Deadline-action trades |
|---|---:|---:|---:|---:|---:|---:|
| `regime_shock_reversion_short_v5_strict_deadline` | 1129 | 1129 | 1129 | 520 | 187 | 0 |
| `regime_shock_reversion_short_v5_trail_at_deadline` | 1129 | 1129 | 1129 | 520 | 187 | 0 |

The controlled harness proves the runtime branch distinction under synthetic deadline exposure. It does not retroactively change PR #255 metrics, verdicts, or artifacts.

## Governance and authority

- Both v5 variants remain `REGISTERED_INACTIVE`.
- `ACTIVE_STRATEGY_IDS` remains empty.
- No paper-observation, broker-dispatch, live-dispatch, promotion, or Phase 6 authority is created.
- No strategy YAMLs, strategy generators, management profile definitions, runtime code, or artifacts are changed.
- This memo is diagnostic evidence only.

## Decision

The harness answers the narrow runtime question that PR #255 could not answer naturally: under controlled deadline exposure, `unconditional_exit` closes at the deadline, while `activate_trail` activates trail at non-negative unrealized R and exits only when unrealized R is negative.
