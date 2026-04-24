# MGMT-01 - Management Profiles and Contract Substrate

Status: implemented

## Scope

MGMT-01 defines the deterministic profile substrate used by later simulated position-management tickets. It does not implement the full position manager, runner loop, sockets, live execution, order routing, or a TUI.

The implementation lives under `apps/strategy_runtime/src/management/` and exposes:

- management profile types;
- V1 management action vocabulary;
- four default V1 strategy profiles;
- deterministic fallback profile resolution;
- pure validation helpers;
- pure candidate-derived target and initial-stop planning helpers.

## Profile Fields

Each `ManagementProfile` includes:

- `profile_id`
- `profile_version`
- `strategy_id`
- `setup_family`
- `profile_hash`
- `initial_stop`
- `targets`
- `break_even`
- `trailing_stop`
- `time_stop`
- `fail_safe`
- `partial_exit`
- deterministic `reasons`

`profile_hash` is currently the explicit placeholder `management_profile_hash_pending_config_v1`. Management profile values are hardcoded for MGMT-01 so later MGMT/ORCH tickets have a typed substrate. A future config migration should move these values into typed management config and replace the placeholder with a deterministic config hash.

## Default Profile Mapping

| Strategy | Profile |
| --- | --- |
| `trend_pullback_long` | `trend_pullback_long_management_v1` |
| `trend_pullback_short` | `trend_pullback_short_management_v1` |
| `breakout_retest_long` | `breakout_retest_long_management_v1` |
| `breakdown_retest_short` | `breakdown_retest_short_management_v1` |

Unknown strategies resolve to `fallback_management_v1` when fallback is enabled. If fallback is disabled, `resolveManagementProfile()` throws an explicit unknown-strategy error.

## Management Action Vocabulary

The V1 management vocabulary is:

- `HOLD`
- `MOVE_STOP`
- `TAKE_PARTIAL`
- `TAKE_PROFIT`
- `EXIT_FULL`
- `MARK_BREAKEVEN`
- `ACTIVATE_TRAIL`
- `FAIL_SAFE_EXIT`
- `TIME_STOP_EXIT`

The existing lowercase action strings remain accepted by the OBS-01 schema for fixture/backward compatibility, but new management producer code should use the uppercase V1 vocabulary above.

## Determinism

MGMT-01 helpers are pure. They do not read wall-clock time, generate random IDs, perform I/O, or recompute market facts.

Candidate-derived helpers read journaled candidate fields only:

- `getTargetPlanFromCandidate()` maps candidate `targets` and `reward_risk` into a profile target plan.
- `computeInitialStopPolicy()` carries the candidate stop forward and explicitly disallows stop widening unless the profile says otherwise.

No helper mutates a `PositionState`.

## Deferred Work

MGMT-02 and MGMT-03 should implement the actual target-position model and position manager state transitions. Those tickets should consume these profiles rather than inventing new action strings or profile shapes.

Deferred behavior includes:

- evaluating target fills against current position state;
- moving stops;
- marking break-even state;
- activating and advancing trailing stops;
- time-stop exits;
- fail-safe exits;
- partial-exit bookkeeping.

## ORCH-02 Journaling Requirements

ORCH-02 and later management producers must journal `MGMT_TICK` and `MGMT_ACTION` events through OBS-01/EVT-01:

- `MGMT_ACTION.type` remains `MGMT_ACTION`;
- `payload.action_type` should use the uppercase V1 vocabulary;
- `event.ts_ns` must inherit from the causation chain, never runtime wall-clock time;
- journaled payloads should include enough reason text to identify the profile and rule used;
- once management config hashing exists, events should include the management profile/config hash.

Existing positions must remain manageable even when RISK-03 circuit breakers block new entries.
