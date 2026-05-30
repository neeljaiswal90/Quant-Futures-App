# MGMT-BUGFIX-FAILSAFE-FILL-MODEL-REVIEW-01

## Code review

- Fail-safe exit price: market.mark_price, falling back to position.entry_price if non-finite
- Stop-hit exit price: position.active_stop_price
- Dispatch order finding: fail-safe preempts stop-hit within a tick when both would fire

## Mark-price source trace

- Call site: apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:393-407
- Value: bar.close via priceNumber(bar.close)
- Event timestamp: bar.last_record_ts_ns
- Fill-realistic: false

## Synthetic tests

| Case | Exit price | Realized R | Realized PnL USD | Pass |
|---|---:|---:|---:|---|
| stop_baseline | 20010 | -1 | -20 | yes |
| failsafe_exactly_1r | 20010 | -1 | -20 | yes |
| failsafe_1_25r | 20012.5 | -1.25 | -25 | yes |
| failsafe_2r | 20020 | -2 | -40 | yes |
| same_bar_stop_and_failsafe | 20020 |  |  | yes |
| bid_ask_short_cover_uses_mark_not_ask | 20020 |  |  | yes |
| profitable_spread_failsafe | 19990 | 1 | 20 | yes |

## Empirical reconciliation

- Empirical average delta: -1263.56 cents/trade
- Implied post-fix R: 1.7613R
- Implied extra slippage: 0.7613R
- Synthetic bracket: between 1.25R and 2.0R, closer to 2.0R

## Determination

- Code: `FILL_MODEL_PESSIMISTIC`
- Basis: Real-archive fail-safe exits use bar.close at bar.last_record_ts_ns and run before declared-stop handling; this can fill a short at the bar close after the stop was already crossed rather than at the stop level or at an ask quote at the crossing moment. The model is deterministic, but the fill-price timing is pessimistic for stop-cross attribution.

## Recommended next ticket

MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-SCOPE-01

## Authority caveat

This ticket changes no engine, strategy, parameter, roster, or authority. It reviews runtime fill-price semantics and does not reopen ADR-0024 LD-024-3 Step 4 verdict reconciliation, which remains coord+operator authority.
