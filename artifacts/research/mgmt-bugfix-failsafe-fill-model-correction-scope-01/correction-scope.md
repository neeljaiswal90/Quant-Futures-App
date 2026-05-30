# MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-SCOPE-01

## Decision

`STOP_PRIORITY_CORRECTION_SCOPE_JUSTIFIED`

Recommended next ticket:

`MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-01`

## Basis

PR #278 recorded `FILL_MODEL_PESSIMISTIC`: real-archive fail-safe exits use `market.mark_price`, sourced from bar close at `bar.last_record_ts_ns`, and fail-safe currently runs before declared stop-hit handling. In same-bar stop+fail-safe overlap, the integrated path exits as fail-safe at the later/worse mark price rather than as a declared stop at `active_stop_price`.

## Recommended scope

Use Option D: stop-priority correction for max-adverse fail-safe overlap.

The implementation should prevent `fail_safe:max_adverse_r_exceeded` from preempting declared stop handling when the same market bar also satisfies the declared stop trigger.

Important clarification: this may make `max_adverse_r=1.0` redundant only for max-adverse bars where the declared stop would also trigger. Other fail-safe subtypes still matter and must not be removed.

## Live / paper parity scan

The live/paper path has real execution surfaces:

- paper/live runner routes `ORDER_INTENT` events into `BrokerAdapterRuntimeIntegration`
- orchestration converts management exits via `createManagementExitOrderIntent`
- management exit intents are market orders
- simulated execution fills market / stop-market intents against BBO with marketable adverse slippage

The next implementation ticket must include live/paper parity tests or explicit analysis so journal/backtest stop-priority semantics and paper/live order-intent semantics do not diverge silently.

## Rejected options

| Option | Reason |
|---|---|
| No change | Leaves documented pessimistic stop-cross attribution intact. |
| Globally use `active_stop_price` for fail-safe exits | Over-broad for spread, stale, invalid, and non-stop-overlap fail-safe cases. |
| Move all fail-safe checks after stop-hit | Could weaken hard safety checks such as stale market, invalid price, invalid quantity, or profile mismatch. |
| Use ask/bid directly in position-manager fail-safe journals | Potentially relevant for live-fill realism, but current evidence points first to same-bar stop-preemption in real-archive attribution. |

## Required next-ticket tests

- Same-bar declared stop and max-adverse-R should resolve as stop-loss at `active_stop_price`.
- Max-adverse-R should still emit fail-safe when declared stop is unavailable or not touched but adverse-R threshold is exceeded.
- Hard fail-safe reasons should still preempt normal management when data/profile/position validity is compromised.
- `max_spread_ticks` fail-safe behavior should remain separately covered.
- Paper/live management exit order intent parity should be asserted for `FAIL_SAFE_EXIT` and stop/exit actions.

## Authority caveat

This decision creates no engine change, strategy change, roster change, paper observation, broker/live dispatch, Phase 6 authority, or ADR reinterpretation.
