# STRAT-02 Trend Pullback Long

`STRAT-02` extracts the V1 `trend_pullback_long` generator into the active strategy runtime.

## Scope

- Active strategy: `trend_pullback_long` only.
- Input contract: `StrategyEvaluationInput` with a `StrategyFeatureSnapshot`.
- Output contract: `StrategyGenerationResult` containing a `StrategyEvaluation` and, when armed, a `Candidate`.
- Registry status: `trend_pullback_long` is now `active`; the other three V1 strategies remain `pending_extraction`.

## Preserved Quantitative Intent

The active generator keeps the legacy strategy's useful gates and geometry:

- bullish supertrend and EMA9 > EMA21 > EMA50 stack;
- RTH, non-halt, non-roll-block session eligibility;
- z-EMA9 pullback band;
- pullback-ratio bounds;
- orderflow/microstructure flow confirmation;
- sigma-based entry band and stop distance;
- upside room check before candidate emission;
- PT1/PT2 reward/risk validation;
- deterministic confidence derived from flow and pullback geometry.

## Boundaries

- No monolithic legacy selector is recreated.
- No shadow/research strategies are added.
- No runner, live execution, sockets, Bookmap, or TradingView code is introduced.
- Thresholds are named constants for this extraction pass. `STRAT-07` will move strategy tuning into typed config.
