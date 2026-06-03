# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-HALT-ROLL-CALENDAR-SOURCE-EXTEND-01 memo

## Context

PR #306 narrowed the remaining source-readiness blocker to explicit halt/roll calendar provenance for `session.is_halt` and `session.is_roll_block`. This ticket evaluates those fields for the same bounded PR #303 2026-06-02 target event without materializing a feature snapshot.

## Determination

`HALT_ROLL_CALENDAR_SOURCE_READY_FOR_FEATURE_BUILDER`

The source-readiness blocker is resolved for calendar-backed halt/roll inputs. The MNQ session calendar classifies the target event as RTH with no maintenance halt or closed-session reason, and the MNQ roll calendar classifies the same timestamp as normal roll phase with `block_new_entries=false` and `flatten_required=false`.

## Field values proven

- `session.is_halt = false` from `getMnqSessionPhase(...).is_maintenance_halt || journal_phase === halted` at `2026-06-02T17:59:59.835478000Z`.
- `session.is_roll_block = false` from `evaluateRoll(...).block_new_entries` at `2026-06-02T17:59:59.835478000Z`.

## Exact source authority

- `session.is_halt`: repo path `apps/strategy_runtime/src/session/mnq-session-calendar.ts; config/session/mnq-session-calendar.yaml`, symbol/function `getMnqSessionPhase(...).is_maintenance_halt and journal_phase`, calendar source `MNQ session calendar`, date basis `target session 2026-06-02-rth; local date 2026-06-02; trading date 2026-06-02`, target timestamp basis `1780423199835478000 / 2026-06-02T17:59:59.835478000Z`, value `false`.
- `session.is_roll_block`: repo path `apps/strategy_runtime/src/session/mnq-roll-calendar.ts; config/session/mnq-roll-calendar.yaml; apps/strategy_runtime/src/session/mnq-session-policy.ts`, symbol/function `evaluateRoll(...).block_new_entries`, calendar source `MNQ roll calendar`, date basis `target session 2026-06-02-rth; UTC ns roll evaluation`, target timestamp basis `1780423199835478000 / 2026-06-02T17:59:59.835478000Z`, value `false`.

Both values are pinned to current repo calendar/session semantics. They do not depend on script-local substitute calendar rules.

## Feature-builder readiness delta

resolves last known source-readiness blocker from PR #306; feature builder implementation may now be scoped, but this PR does not authorize implementation or observation-day credit.

## Important boundary

This is calendar source-readiness only. It does not claim a live exchange halt-feed integration, does not emit a `StrategyFeatureSnapshot`, does not invoke paper runtime, and does not create observation-day or authority credit.

## Recommended next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SNAPSHOT-BUILDER-IMPL-01`
