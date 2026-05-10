# QFA-201c Full Lifecycle Modeling

## Status

QFA-201c extends the QFA-201b real-archive execution surface from architecture validation into representative multi-bar lifecycle modeling. The change is additive to `apps/backtester/src/real-archive-execution/` and preserves the existing QFA-201 replay-sanity runner.

## Step 0 findings

- Base: post-PR #165 main (`f84f501`).
- ADR-0010 through ADR-0016 are present.
- QFA-201b real-archive execution module is present.
- Cycle1 roster remains the four active strategies: `trend_pullback_long`, `trend_pullback_short`, `breakout_retest_long`, `breakdown_retest_short`.
- Strategies do not emit standalone `strategy_exit` directives. They do emit candidate-level entry, stop, risk, and pt1/pt2 target semantics.
- Existing management profiles provide stop, target, break-even, trailing, time-stop, and fail-safe behavior through `apps/strategy_runtime/src/management/`.
- QFA-201c therefore consumes candidate stop/target semantics plus the existing position-manager profile layer. No strategy implementation changes are required.

## v1 to v2 change

QFA-201b proved the end-to-end event path, but closed positions on the next bar. QFA-201c removes that shortcut:

- Entry opens a `TargetPosition` through `buildTargetPositionFromCandidate` and `applyInitialFillToTargetPosition`.
- Each subsequent bar updates MFE/MAE from bar high/low.
- Each subsequent bar evaluates `evaluatePositionManager`.
- Exit fills are emitted only when stop, target, time-stop, fail-safe, or session-close semantics trigger.
- Existing QFA-203 and QFA-204 surfaces continue to produce closed-trade and PnL analysis.

## Exit taxonomy

The per-trade schema now carries:

- `exit_reason`: `stop_loss`, `target`, `time_stop`, `strategy_exit`, `session_close`, `fail_safe`, or `unknown`.
- `exit_bar_index`: number of bars held after entry.
- `max_favorable_excursion_cents`: best unrealized PnL during the hold.
- `max_adverse_excursion_cents`: worst unrealized PnL during the hold.

`strategy_exit` is reserved for a future explicit strategy directive surface. It is not emitted by the current four StrategyGenerationResult implementations.

## Deterministic precedence

QFA-201c delegates normal precedence to the existing position manager:

1. Fail-safe
2. Stop
3. Target
4. Time stop
5. Break-even
6. Trailing stop

Session close is applied by the runner after the final streamed bar if a position remains open. This guarantees every session-scoped execution closes deterministically without requiring a live overnight carry model.

## MFE and MAE methodology

For long positions:

- Favorable price = bar high.
- Adverse price = bar low.

For short positions:

- Favorable price = bar low.
- Adverse price = bar high.

PnL is converted using MNQ economics already used by the backtester valuation defaults: 0.25 index-point tick size and 50 cents per tick.

## Scope discipline

QFA-201c does not modify:

- QFA-105 queue synthesis.
- QFA-203 trade ledger contracts.
- QFA-204 equity metrics contracts.
- QFA-310 validation gate.
- QFA-410 held-out validation.
- Strategy implementations or strategy parameters.
- Determinism CI.

## Validation

The unit fixture exercises a multi-bar lifecycle:

- Bar 1: entry opens.
- Bar 2: position remains open while MFE updates.
- Bar 3: stop-loss exit fires.

The fixture asserts the enriched per-trade fields and byte-stable output hash.

