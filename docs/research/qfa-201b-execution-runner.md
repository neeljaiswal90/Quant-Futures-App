# QFA-201b real-archive execution runner

## Summary

QFA-201b adds an additive real-execution runner surface beside the existing QFA-201 replay-sanity runner. The existing `runBacktest` behavior remains unchanged: it still emits `BACKTEST_RUN_META`, `BAR_CLOSE`, and `STRAT_EVAL` events for deterministic replay-sanity coverage.

The new `runRealArchiveBacktest` surface wires existing primitives into the missing execution path:

- QFA-201 bar construction via the existing DBN/bar-builder path.
- QFA-105 queue synthesis through `synthesizeQueue` in `mbp_trades_proxy` mode.
- QFA-203 trade ledger reduction from `CANDIDATE -> ORDER_INTENT -> SIM_FILL`.
- QFA-204 PnL/equity metrics through `analyzeTradeLedger`.

## Step 0 findings

- ADR-0010 through ADR-0016 are present.
- Tier A Feb-Mar-Apr archive inputs are present locally.
- ACTIVE_STRATEGY_IDS remains the locked Cycle1 roster of four strategies.
- QFA-203 trade ledger is available and consumes `SIM_FILL` events.
- QFA-204 equity metrics are available and compute realized PnL from closed trades.
- QFA-105 queue synthesis is available with `mbp_trades_proxy`.
- The existing QFA-201 runner is replay-sanity only and does not emit order/fill/position events.

## Architecture decision

QFA-201b uses an additive wrapper rather than changing `runBacktest`. This preserves QFA-201 behavior and gives QFA-410b a separate execution-grade entry point.

The new runner accepts session-scoped real-archive sources as either DBN paths or async record iterables. For unit coverage, synthetic record iterables exercise the same execution code path without requiring the operational archive in CI.

## Per-trade schema

The runner emits enriched per-trade records with:

- `strategy_id`
- `session_id`
- `regime_label`
- `side`
- `entry_ts_ns`
- `exit_ts_ns`
- `entry_px`
- `exit_px`
- `quantity`
- `pnl_cents`
- `spread_bucket`
- `queue_ahead_bucket`
- `fill_quality_metric`

This matches the metadata QFA-410b and QFA-611-evidence need for downstream evidence package construction.

## Determinism

The unit fixture runs the same synthetic archive inputs twice and verifies byte-stable per-trade records by SHA-256 over a stable JSON representation. The runner does not modify the determinism CI gate.

Expected determinism baselines remain:

- Phase 2: `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b`
- Phase 4: `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090`

## Limits

QFA-201b v1 uses a simple one-bar lifecycle: a filled entry is closed on the next available bar. This is sufficient to prove the foundational execution path and per-trade output contract. Full management profile semantics, partial-fill lifecycle complexity, and production latency modeling remain out of scope for this ticket.

QFA-410b remains responsible for held-out window orchestration. QFA-611-evidence remains responsible for evidence package construction.
