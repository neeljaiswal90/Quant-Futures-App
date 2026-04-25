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

1. Publish `FEATURES`, caused by the source market event.
2. Run every executable V1 strategy with the loaded STRAT-07 config.
3. Publish one `STRAT_EVAL` per strategy.
4. Publish a `CANDIDATE` for each armed candidate.
5. Publish `RANK` with the STRAT-06 deterministic ranking method.
6. Run sizing and risk for the top configured candidate count; V1 defaults to one.
7. Publish `SIZING` and `RISK_GATE`.
8. If accepted, publish `ORDER_INTENT`.
9. Submit to the SIM-01 simulated adapter and publish `SIM_FILL`.
10. Build/open an MGMT-02 target position and publish `POSITION`.

For each management market tick:

1. Evaluate MGMT-03 against every open target position.
2. Publish `MGMT_TICK`.
3. Publish zero or more `MGMT_ACTION` events.
4. Publish the resulting `POSITION` summary.
5. Update session risk realized PnL and open/closed trade counts deterministically.

## Lineage

Every runner-created envelope carries APP-03 `config_hash` via `event.config`.

Strategy/ranking/decision payloads also carry `strategy_config_hash` from STRAT-07 so replay can prove which threshold bundle created the event. Risk and management YAML hashes are still future work; until then, RISK/MGMT payloads retain their version strings and placeholder/profile metadata.

## Session Risk

The runner creates session risk state lazily from the first feature snapshot if no initial state is supplied. New accepted simulated fills increment open-trade count. Risk rejections increment rejected-trade count. Closed positions decrement open-trade count and apply realized PnL. `SESSION_PHASE` resets are exposed through `processSessionPhase`.

## ORCH-03 Boundary

ORCH-02 composes the candidate-to-position path and management evaluation. ORCH-03 can still add richer fill-to-manager integration behavior, persistence wiring, or management-decision engine extensions if needed, but the deterministic substrate is now present.
