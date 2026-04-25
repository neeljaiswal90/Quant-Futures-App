# RISK-03 - Session Risk Circuit Breaker and Daily Trade Controls

Status: implemented

## Scope

RISK-03 adds deterministic session/account risk controls for simulated V1:

- daily realized-loss limit;
- maximum currently open trade count;
- maximum trades opened per session;
- account/session circuit breaker.

This is a pure risk layer. It does not implement a runner, sockets, live execution, TUI controls, or broker account mutation.

## State Model

`apps/strategy_runtime/src/risk/account-risk-arbiter.ts` defines `SessionRiskState`:

- `session_id`
- `account_ref`
- `symbol`
- `realized_pnl_usd`
- `open_trade_count`
- `closed_trade_count`
- `rejected_trade_count`
- `circuit_breaker_state`
- `circuit_breaker_reason`
- `last_transition_ts_ns`

`last_transition_ts_ns` is caller-provided event time. The module never reads wall-clock time.

## Policy Fields

`SessionRiskPolicy` supports:

- `max_daily_realized_loss_usd`
- `max_open_trade_count`
- `max_trades_per_session`
- `circuit_breaker_enabled`
- `reset_circuit_breaker_on_new_session`

`RiskPolicyConfig.session` carries the resolved session policy. CFG-01 moves runtime risk policy into:

```text
config/risk/risk-policy.yaml
```

`loadRiskPolicyConfig()` validates the YAML, canonicalizes the typed policy, and emits `risk_config_hash` for replay lineage. `default_regime` is a typed literal union, not an arbitrary string.

## State Transitions

The pure update helpers are:

- `createSessionRiskState`
- `updateSessionRiskState`
- `applyRealizedPnl`
- `evaluateSessionCircuitBreaker`
- `activateSessionCircuitBreaker`
- `clearSessionCircuitBreaker`
- `resetSessionRiskState`

Realized loss activates the circuit breaker when:

```text
abs(min(realized_pnl_usd, 0)) >= max_daily_realized_loss_usd
```

Manual activation is supported through an explicit update event. Clearing/resetting requires a caller-provided timestamp.

## Entry Blocking

`canOpenNewTrade` blocks new entries when any of these is true:

- circuit breaker is active;
- daily realized-loss limit is reached;
- current open-trade count is at the cap;
- session trade-open count is at the cap.

`evaluateRiskGate` consumes `state.session_risk` when present and includes stable `session_risk:*` rejection reasons in the returned `RiskGateDecision`.

## Existing Position Management

`canManageExistingPosition` always allows management activity. This preserves the V1 rule that circuit breakers block new entries but existing simulated positions remain managed.

## Reset Behavior

`resetSessionRiskState` resets PnL and counters at a new session. It clears the circuit breaker when `reset_circuit_breaker_on_new_session` is true, which is the V1 default.

## Journaling Requirements for ORCH-02

ORCH-02 should:

- pass `session_risk` into `assessCandidateRisk`;
- journal every `RISK_GATE` decision;
- include `risk_manager_version`;
- include `risk_config_hash`;
- include the session risk summary from `toRiskGateEventPayload`;
- use the candidate/causation event timestamp as `decided_ts_ns`;
- never use `Date.now()` or local wall-clock time for transition timestamps.

`RiskGateEventPayload.session_risk` is optional to preserve OBS-00 fixture compatibility, but runtime producers should include it once ORCH-02 owns session state.
