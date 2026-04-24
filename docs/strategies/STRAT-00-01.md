# STRAT-00 / STRAT-01 Strategy Foundation

This slice creates the strategy extraction landing zone without reviving the legacy strategy shell.

## Scope

- `STRAT-00` adds deterministic synthetic feature snapshot fixtures for the four V1 strategy paths.
- `STRAT-01` adds the active strategy registry with exactly the four deterministic launch strategies.
- Strategy math remains pending for `STRAT-02` through `STRAT-05`.
- No shadow strategies, legacy selector, runner loop, live execution, Bookmap, or TradingView path is introduced.

## Active Strategy IDs

- `trend_pullback_long`
- `trend_pullback_short`
- `breakout_retest_long`
- `breakdown_retest_short`

## Fixture Contract

The synthetic fixtures live under `apps/strategy_runtime/tests/fixtures/strategies/`.
They are typed against the active strategy input contract and cover:

- bullish trend pullback;
- bearish trend pullback;
- bullish breakout retest;
- bearish breakdown retest.

The fixtures intentionally use fixed nanosecond timestamps, static MNQ instrument identity, stable config lineage, and deterministic bar/feature values. They do not load DATA-04 output and do not infer strategy decisions.

## Registry Rule

`apps/strategy_runtime/src/strategies/registry.ts` is metadata-only until the individual strategy extraction tickets land. Every entry is marked `pending_extraction` and points at its owning extraction ticket:

- `STRAT-02`: `trend_pullback_long`
- `STRAT-03`: `trend_pullback_short`
- `STRAT-04`: `breakout_retest_long`
- `STRAT-05`: `breakdown_retest_short`

`ORCH-02` must not treat a registry entry as executable until the entry is promoted by its extraction ticket.
