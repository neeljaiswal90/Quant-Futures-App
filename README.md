# Quant Futures App

Quant futures alpha-validation platform for deterministic MNQ backtesting, data lineage, and replay-safe strategy evaluation.

## Current development status

- Data foundation, deterministic backtester core, held-out validation, execution validators, paper-trading harness, and shadow market-data lanes are complete.
- ADR-0024 re-derivation is complete. The fixed management engine preserved the Cycle3 verdict set, and `artifacts/strategy-selection/strategy-selection-v3.json` sha256 `CEE1B8DCE63CFD292487721D38110B2E637646E96B3B9641BDC1B984329ABEDB` is now authoritative.
- `regime_shock_reversion_short_v2` is the active strategy advanced to paper validation. Re-derived held-out metrics on the fixed engine: Sharpe `5.0542`, DSR `3.7799`, PSR_zero `0.999998`, profit factor `1.4180`, total trades `571`, verdict `ADVANCE_TO_PAPER`.
- `vwap_overnight_reversal_short` and `vwap_overnight_reversal_long` remain rejected after re-derivation.
- Shadow validation is operational through both live ticker sidecar wiring and local OBS replay, with on-disk JSONL journal persistence for forensic review.
- Broker-real lane status: async Rithmic substrate and account allowlist are in place; QFA-612-BROKER-03 is unblocked and is the next milestone for LUCIDFLEX paper ORDER_PLANT lifecycle.

## Paper validation strategy

The current paper-validation candidate is `regime_shock_reversion_short_v2`, a mean-reversion MNQ strategy selected by the Cycle3 inference process under ADR-0016 thresholds. It is authorized for paper validation only; live-money execution remains out of scope.

Paper validation objectives:

- Exercise the strategy against the paper-trading harness with `mode = paper`.
- Preserve mock-only order behavior until the BROKER-03 ORDER_PLANT path is explicitly merged and enabled.
- Accumulate the CF-52 paper-observation window before any live-promotion decision.
- Keep the Cycle3 parameter locks, regime substrate, and ADR-0016 thresholds unchanged during the observation window.

Audit references:

- Re-derivation memo: `docs/research/qfa-611-cycle3-rederivation-memo.md`.
- Closure memo amendment: `docs/research/qfa-611-cycle3-closure-memo.md`.
- Authoritative selection artifact: `artifacts/strategy-selection/strategy-selection-v3.json`.

