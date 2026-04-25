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
- `MGMT_ACTION` events inherit from `MGMT_TICK` or the roll advisory/source event that triggered them;
- management-driven close `ORDER_INTENT`, `SIM_FILL`, and `POSITION` events inherit through `MGMT_ACTION -> ORDER_INTENT -> SIM_FILL`.

The runner never calls `Date.now`, `new Date`, or any wall-clock helper.

## Composition Flow

For each feature snapshot:

1. Evaluate MNQ session/roll eligibility from `exchange_event_ts_ns`/`created_ts_ns`.
2. Emit `SESSION_PHASE` when the MNQ session phase or trading date changes.
3. Emit `ROLL_ADVISORY` when roll advisory state changes.
4. If roll policy enters `flatten_required`, emit one `EXIT_FULL` `MGMT_ACTION` for each open position and execute it through the simulated close-fill bridge.
5. Publish `FEATURES`, caused by the source market event.
6. If MNQ eligibility blocks new entries, publish blocked `STRAT_EVAL` events with stable MNQ reason codes and do not emit `CANDIDATE` events.
7. If eligible, run every executable V1 strategy with the loaded STRAT-07 config.
8. Publish one `STRAT_EVAL` per strategy.
9. Publish a `CANDIDATE` for each armed candidate.
10. Publish `RANK` with the STRAT-06 deterministic ranking method.
11. Run sizing and risk for the top configured candidate count; V1 defaults to one.
12. Publish `SIZING` and `RISK_GATE`.
13. If accepted, publish `ORDER_INTENT`.
14. Submit to the SIM-01 simulated adapter and publish `SIM_FILL`.
15. Build/open an MGMT-02 target position and publish `POSITION`.

For each management market tick:

1. Evaluate MGMT-03 against every open target position.
2. Publish `MGMT_TICK`.
3. Publish zero or more `MGMT_ACTION` events.
4. For exit actions (`TAKE_PARTIAL`, `TAKE_PROFIT`, `EXIT_FULL`, `TIME_STOP_EXIT`, `FAIL_SAFE_EXIT`), publish `ORDER_INTENT`, submit to SIM-01, publish `SIM_FILL`, and publish the resulting `POSITION` summary caused by the fill.
5. For non-exit management actions, publish the resulting `POSITION` summary caused by the latest management action or tick.
6. Update session risk realized PnL and open/closed trade counts deterministically.

## MNQ Session And Roll Eligibility

ORCH-02A wires the MNQ-01 helper into the runner. The runner consumes the configured or default MNQ session and roll calendars and calls `evaluateMnqSessionEligibility` before strategy evaluation.

New-entry blocking reasons are journaled as `STRAT_EVAL.gate_state = "blocked"` with reason codes:

- `mnq_eligibility:outside_rth`
- `mnq_eligibility:maintenance_halt`
- `mnq_eligibility:session_closed`
- `mnq_eligibility:roll_block_window`
- `mnq_eligibility:roll_flatten_window`

`SESSION_PHASE` and `ROLL_ADVISORY` events are emitted only on transition or meaningful advisory changes, not on every tick. Both are caused by the current source market event and inherit its `ts_ns`.

Existing-position management is not blocked merely because new entries are blocked. Open positions continue through the MGMT-03 tick/action path. ORCH-02B adds the roll exception: when roll eligibility reports `flatten_required`, the runner emits an `MGMT_ACTION` with `action_type = "EXIT_FULL"` and `reason = "roll_window_flatten"` for each open position.

Forced-flatten actions are caused by the `ROLL_ADVISORY` event when that advisory is emitted, otherwise by the same source market event that caused the advisory state. The action `ts_ns` always equals the causation event timestamp. Positions are processed in `position_id` ascending order, and duplicate `EXIT_FULL` actions are suppressed per `position_id + cutover_ts_ns` so repeated ticks inside the same flatten window do not reissue the same close request.

ORCH-02C wires those forced-flatten actions into the same simulated close lifecycle used by ordinary management exits. Each executable management action is idempotent by `management_action_id`: duplicates inside a runner instance are ignored after the first simulated execution. The emitted chain is:

```text
MGMT_ACTION -> ORDER_INTENT -> SIM_FILL -> POSITION
```

The close order is marketable and side-correct: long positions close with `sell`, short positions close with `buy`. The bridge is still sim-only; no live broker routing or DATA-01 dependency is introduced.

## Lineage

Every runner-created envelope carries APP-03 `config_hash` via `event.config`.

Strategy/ranking/decision payloads also carry `strategy_config_hash` from STRAT-07 so replay can prove which threshold bundle created the event.

CFG-01 adds the remaining config lineage:

- `SIZING` and `RISK_GATE` carry `risk_config_hash` plus `risk_manager_version`.
- `POSITION`, `MGMT_TICK`, `MGMT_ACTION`, management close `ORDER_INTENT`, and management close `SIM_FILL` carry `management_profile_hash`, `management_profile_id`, and `management_profile_version`.
- `MGMT_TICK`, `MGMT_ACTION`, management close `ORDER_INTENT`, and management close `SIM_FILL` carry `position_manager_version`.

The runner consumes loaded YAML config from `loadAppConfig()`: `config/risk/risk-policy.yaml` and `config/management/profiles.yaml`.

## Session Risk

The runner creates session risk state lazily from the first feature snapshot if no initial state is supplied. New accepted simulated fills increment open-trade count. Risk rejections increment rejected-trade count. Closed positions decrement open-trade count and apply realized PnL. `SESSION_PHASE` resets are exposed through `processSessionPhase`.

## ORCH-03 Boundary

ORCH-02 composes the candidate-to-position path and management evaluation. ORCH-03 can still add richer fill-to-manager integration behavior, persistence wiring, or management-decision engine extensions if needed, but the deterministic substrate is now present.
