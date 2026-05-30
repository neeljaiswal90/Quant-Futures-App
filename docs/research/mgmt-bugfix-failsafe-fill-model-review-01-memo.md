# MGMT-BUGFIX-FAILSAFE-FILL-MODEL-REVIEW-01 Memo

## 1. Context

PR #277 found that v2 deterioration is dominated by stop_loss-to-fail_safe matched-pair deterioration, not target-to-fail_safe winner cutting. This review asks whether the fail-safe fill-price model itself is realistic enough to support thesis falsification.

## 2. Code review (Q1)

Fail-safe exits at `market.mark_price`; stop-hit exits at `position.active_stop_price`. For short positions with `max_adverse_r = 1.0`, fail-safe fires when mark reaches or exceeds the stop-distance threshold. The fail-safe exit is therefore worse-or-equal to the declared stop when the adverse mark is beyond the stop.

## 3. Mark-price source trace (Q1 continued)

The real-archive runner passes `mark_price: priceNumber(bar.close)` and `event_ts_ns: bar.last_record_ts_ns` to `evaluatePositionManager`. It also passes `bar.high` and `bar.low` for stop/target detection and latest bid/ask when available, but fail-safe exit-price selection ignores ask for short covers.

## 4. Synthetic test results (Q2)

The synthetic tests document current behavior without production-code changes: stop baseline exits at 20010 / -1R, fail-safe at 1R exits at 20010 / -1R, fail-safe at 1.25R exits at 20012.5 / -1.25R, and fail-safe at 2R exits at 20020 / -2R. A same-bar stop+fail-safe case is resolved as fail-safe because fail-safe runs before stop-hit.

## 5. Dispatch-order analysis

The position-manager order is fail-safe, PT1 touch marking, stop-hit, target hits, time-stop, break-even, trailing. This means fail-safe can preempt a declared stop on a bar where both conditions are true.

## 6. Pre-fix vs post-fix diff

The d1d7461 parent already used `market.mark_price` as fail-safe exit price. MGMT-BUG-FIX-02 added the max-adverse-R and max-spread enforcement branches; it did not introduce the mark-price fill model. The mark-price model was dormant until the guard began firing.

## 7. Empirical reconciliation (Q2 continued)

PR #277 stop_loss-to-fail_safe pairs averaged -1659.75 cents pre-fix versus -2923.31 cents post-fix. The average deterioration is -1263.56 cents/trade, or 0.7613R beyond the pre-fix stop-risk proxy. The post-fix average is 1.7613R, between the synthetic 1.25R and 2R cases.

## 8. Realism judgment (Q3)

The backtest model is deterministic and internally explainable, but it is pessimistic for stop-cross attribution because the fail-safe fills at bar close at the bar end after stop crossing, rather than at the declared stop or an execution quote at the crossing moment. For a real short cover, ask-side fill realism is also not represented by the fail-safe exit-price field.

## 9. Determination

Determination: `FILL_MODEL_PESSIMISTIC`.

Real-archive fail-safe exits use bar.close at bar.last_record_ts_ns and run before declared-stop handling; this can fill a short at the bar close after the stop was already crossed rather than at the stop level or at an ask quote at the crossing moment. The model is deterministic, but the fill-price timing is pessimistic for stop-cross attribution.

## 10. Recommended next ticket

MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-SCOPE-01

## 11. Authority caveat

This ticket changes no engine, strategy, parameter, roster, or authority. It reviews runtime fill-price semantics and does not reopen ADR-0024 LD-024-3 Step 4 verdict reconciliation, which remains coord+operator authority.

This ticket changes no engine, strategy, parameter, roster, or authority. It reviews runtime fill-price semantics and does not reopen ADR-0024 LD-024-3 Step 4 verdict reconciliation, which remains coord+operator authority.
