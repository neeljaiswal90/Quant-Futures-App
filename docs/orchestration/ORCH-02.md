# ORCH-02 - Deterministic Runner Loop

Status: implemented

## Scope

ORCH-02 adds the pure TypeScript runner composition layer. It wires the already-merged substrate pieces:

- ORCH-01 event bus and engine container;
- STRAT-02..07 strategy generators, ranking, and strategy-config lineage;
- RISK-01..03 sizing, risk gate, and session-risk controls;
- SIM-01 deterministic simulated execution adapter;
- MGMT-01..03 target positions and position-manager actions.

It does not add a daemon scheduler, sockets, live execution, TUI behavior, sidecar code, or a full feature builder. DATA/FEAT tickets still own live feature construction. The ORCH-02 runner consumes already-built `StrategyFeatureSnapshot` values and already-journaled source events.

## Timestamp And Causation Rule

The runner follows ADR-0001 and EVT-01:

- source market-data events are published before the runner derives from them;
- `FEATURES.ts_ns` equals the triggering source event timestamp;
- `STRAT_EVAL`, `CANDIDATE`, `RANK`, `SIZING`, `RISK_GATE`, `ORDER_INTENT`, `SIM_FILL`, and `POSITION` inherit the same causation-chain timestamp;
- management ticks inherit the source market event timestamp;
- `MGMT_ACTION` and management `POSITION` updates inherit from `MGMT_TICK`.

The runner never calls `Date.now`, `new Date`, or any wall-clock helper.

## Composition Flow

For each feature snapshot:

1. Evaluate MNQ session/roll eligibility from `exchange_event_ts_ns`/`created_ts_ns`.
2. Emit `SESSION_PHASE` when the MNQ session phase or trading date changes.
3. Emit `ROLL_ADVISORY` when roll advisory state changes.
4. Publish `FEATURES`, caused by the source market event.
5. If MNQ eligibility blocks new entries, publish blocked `STRAT_EVAL` events with stable MNQ reason codes and do not emit `CANDIDATE` events.
6. If eligible, run every executable V1 strategy with the loaded STRAT-07 config.
7. Publish one `STRAT_EVAL` per strategy.
8. Publish a `CANDIDATE` for each armed candidate.
9. Publish `RANK` with the STRAT-06 deterministic ranking method.
10. Run sizing and risk for the top configured candidate count; V1 defaults to one.
11. Publish `SIZING` and `RISK_GATE`.
12. If accepted, publish `ORDER_INTENT`.
13. Submit to the SIM-01 simulated adapter and publish `SIM_FILL`.
14. Build/open an MGMT-02 target position and publish `POSITION`.

For each management market tick:

1. Evaluate MGMT-03 against every open target position.
2. Publish `MGMT_TICK`.
3. Publish zero or more `MGMT_ACTION` events.
4. Publish the resulting `POSITION` summary.
5. Update session risk realized PnL and open/closed trade counts deterministically.

## MNQ Session And Roll Eligibility

ORCH-02A wires the MNQ-01 helper into the runner. The runner consumes the configured or default MNQ session and roll calendars and calls `evaluateMnqSessionEligibility` before strategy evaluation.

New-entry blocking reasons are journaled as `STRAT_EVAL.gate_state = "blocked"` with reason codes:

- `mnq_eligibility:outside_rth`
- `mnq_eligibility:maintenance_halt`
- `mnq_eligibility:session_closed`
- `mnq_eligibility:roll_block_window`
- `mnq_eligibility:roll_flatten_window`

`SESSION_PHASE` and `ROLL_ADVISORY` events are emitted only on transition or meaningful advisory changes, not on every tick. Both are caused by the current source market event and inherit its `ts_ns`.

Existing-position management is not blocked merely because new entries are blocked. Open positions continue through the MGMT-03 tick/action path. Roll `flatten_required` is surfaced as a journal advisory; the actual forced flatten action remains a follow-up until DATA-06 provides production roll calendars and ORCH consumes the finalized roll policy.

## Lineage

Every runner-created envelope carries APP-03 `config_hash` via `event.config`.

Strategy/ranking/decision payloads also carry `strategy_config_hash` from STRAT-07 so replay can prove which threshold bundle created the event.

CFG-01 adds the remaining config lineage:

- `SIZING` and `RISK_GATE` carry `risk_config_hash` plus `risk_manager_version`.
- `POSITION`, `MGMT_TICK`, and `MGMT_ACTION` carry `management_profile_hash`, `management_profile_id`, and `management_profile_version`.
- `MGMT_TICK` and `MGMT_ACTION` carry `position_manager_version`.

The runner consumes loaded YAML config from `loadAppConfig()`: `config/risk/risk-policy.yaml` and `config/management/profiles.yaml`.

## Session Risk

The runner creates session risk state lazily from the first feature snapshot if no initial state is supplied. New accepted simulated fills increment open-trade count. Risk rejections increment rejected-trade count. Closed positions decrement open-trade count and apply realized PnL. `SESSION_PHASE` resets are exposed through `processSessionPhase`.

## ORCH-03 Boundary

ORCH-02 composes the candidate-to-position path and management evaluation. ORCH-03 can still add richer fill-to-manager integration behavior, persistence wiring, or management-decision engine extensions if needed, but the deterministic substrate is now present.
