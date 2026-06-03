# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SOURCE-RECHECK-01 memo

## Context

PR #303 moved the paper-observation source-readiness lane to 2026-06-02 and proved RTH source coverage, closed bars, session VWAP, ATR14, signed-shock source value, and VIX/VXN prior close. PR #304 proved regime-label source inputs. PR #305 acquired a scoped paper-observation regime-label source without mutating global regime labels.

## Determination

`FEATURE_SOURCE_RECHECK_BLOCKED_SESSION_STATE`

Blocker subclassification: `SESSION_STATE_SOURCE_BLOCKED_MISSING_EXPLICIT_HALT_ROLL_CALENDAR`

The recheck is not ready for feature-builder implementation because explicit source provenance for `session.is_halt` and `session.is_roll_block` is still missing from the merged source surfaces. `session.is_rth` is supported by the 2026-06-02 RTH source window, so this is not a broad RTH/session-basis blocker.

Current repo code does not expose a paper/local replay default for the exact `SessionState.is_halt` and `SessionState.is_roll_block` fields. The MNQ session calendar can derive phase and `is_maintenance_halt`, but that is not a builder-ready source for both behavior-bearing `SessionState` flags. Therefore the top-level determination remains `FEATURE_SOURCE_RECHECK_BLOCKED_SESSION_STATE`, while the next ticket is narrowed to halt/roll calendar source provenance.

## Ready source families

- `created_ts_ns`
- `quote.mid_px`
- `session.is_rth`
- `indicators.sigma_pts` source bars
- `context.regime_label` scoped source
- `context.signed_shock_vwap.value` source value
- `regime_shock_reversion_short_v2_utc_16_18_exclusion` config lineage

## Blocking source family

- `session.is_halt`
- `session.is_roll_block`

## Session field source-code provenance

- Field: `session.is_halt / session.is_roll_block`
- Repo path(s): `apps/strategy_runtime/src/contracts/market.ts; apps/strategy_runtime/src/session/mnq-session-calendar.ts; apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2.ts`
- Current default behavior: `no default found` for the exact `SessionState` fields in paper/local replay source paths checked by this ticket.
- External source required: `true`, unless a later scoped ticket explicitly documents a conservative default.

## Authority caveat

This source-readiness diagnostic does not materialize a StrategyFeatureSnapshot, does not emit strategy runtime markers, does not run qfa-410b/qfa-611, does not mutate global regime labels, does not award observation-day credit, and creates no paper/live/broker/Phase 6/roster authority.

## Recommended next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-HALT-ROLL-CALENDAR-SOURCE-EXTEND-01`

session.is_rth is already source-ready; the remaining session-state blocker is explicit halt/roll calendar provenance or a deliberate documented conservative default for session.is_halt=false and session.is_roll_block=false.
