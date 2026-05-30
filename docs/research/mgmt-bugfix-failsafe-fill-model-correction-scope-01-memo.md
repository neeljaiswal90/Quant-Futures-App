# MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-SCOPE-01 Memo

## 1. Context

PR #278 merged the fail-safe fill-model review and recorded `FILL_MODEL_PESSIMISTIC`. The review found that real-archive fail-safe exits use `market.mark_price`, sourced from the bar close at `bar.last_record_ts_ns`, and fail-safe evaluation currently runs before declared stop-hit evaluation.

This ticket is decision-only. It scopes whether a correction implementation is justified and what the narrow correction should be. It does not change engine code, strategy code, management profiles, artifacts, rosters, or authority.

## 2. Preflight substrate

| Item | Value |
|---|---|
| Base | `origin/main@b0c5e2dc5593aee4004020479fea073213980aa6` |
| PR #278 | present |
| Predecessor artifact | `artifacts/research/mgmt-bugfix-failsafe-fill-model-review-01/fill-model-review.json` |
| Predecessor determination | `FILL_MODEL_PESSIMISTIC` |

## 3. Evidence summary

The predecessor review established:

- fail-safe exit price is `market.mark_price`, with `entry_price` fallback
- real-archive mark price is bar close at `bar.last_record_ts_ns`
- fail-safe currently evaluates before declared stop-hit handling
- same-bar stop+fail-safe synthetic case exits as `fail_safe:max_adverse_r_exceeded` at `20020`, while stop baseline exits at `20010`
- PR #277 stop_loss-to-fail_safe empirical deterioration averaged `-1263.56` cents / `0.7613R` beyond the pre-fix stop-risk proxy

## 4. Live / paper parity scan

Live and paper execution surfaces exist and must stay in scope for any correction implementation.

Relevant findings:

- `PaperTradingRunner` subscribes to `ORDER_INTENT` events and routes them through `BrokerAdapterRuntimeIntegration`.
- The orchestration runner converts management exits through `createManagementExitOrderIntent`.
- `createManagementExitOrderIntent` creates market exit order intents.
- simulated execution fills market and stop-market orders against BBO with marketable adverse slippage.
- position-manager fail-safe journal actions still carry the mark-price-derived `exit_price`.

Therefore, correction scoping is sufficient, but the implementation ticket must explicitly test paper/live order-intent parity. The current decision must not claim that live broker fill semantics are already equivalent to the real-archive journaled exit-price model.

## 5. Decision output

Decision:

`STOP_PRIORITY_CORRECTION_SCOPE_JUSTIFIED`

Recommended next ticket:

`MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-01`

## 6. Recommended correction scope

Preferred option:

`Option D: stop-priority correction for max-adverse fail-safe overlap`

The implementation should prevent `fail_safe:max_adverse_r_exceeded` from preempting declared stop handling when the same market bar also satisfies the declared stop trigger.

Important clarification:

This may make `max_adverse_r=1.0` redundant only for max-adverse bars where the declared stop would also trigger. Other fail-safe subtypes still matter and must not be removed.

## 7. Rejected alternatives

| Option | Reason |
|---|---|
| No change | Leaves documented `FILL_MODEL_PESSIMISTIC` stop-cross attribution intact. |
| Globally use `active_stop_price` for fail-safe exits | Over-broad and wrong for spread, stale, invalid, and non-stop-overlap fail-safe cases. |
| Globally move all fail-safe checks after stop-hit | Could weaken hard safety checks such as stale market, invalid price, invalid quantity, and profile mismatch. |
| Use ask/bid directly in position-manager fail-safe journals | Potentially relevant for live-fill realism, but the reviewed defect is first same-bar stop-preemption in real-archive attribution. |

## 8. Expected implementation scope

Likely implementation files:

- `apps/strategy_runtime/src/management/position-manager/fail-safe.ts`
- `apps/strategy_runtime/src/management/position-manager/index.ts`
- management unit tests
- orchestration or paper/live parity tests for management exit order-intent behavior
- research memo/backlog row

Required implementation tests:

- same-bar declared stop and max-adverse-R resolves as stop-loss at `active_stop_price`
- max-adverse-R still emits fail-safe when declared stop is unavailable or not touched but adverse-R threshold is exceeded
- hard fail-safe reasons still preempt normal management when data/profile/position validity is compromised
- `max_spread_ticks` fail-safe behavior remains covered separately
- paper/live management exit order intent parity is asserted for `FAIL_SAFE_EXIT` and stop/exit actions

## 9. Authority caveat

This decision creates no engine change, strategy change, roster change, paper observation, broker/live dispatch, Phase 6 authority, or ADR reinterpretation.
