# STRAT-07 Strategy Config Surface

`STRAT-07` moves V1 strategy and ranking tuning values into typed YAML-backed config.

## Files

The committed baseline files are:

- `config/strategies/shared.yaml`
- `config/strategies/trend_pullback_long.yaml`
- `config/strategies/trend_pullback_short.yaml`
- `config/strategies/breakout_retest_long.yaml`
- `config/strategies/breakdown_retest_short.yaml`

They are public runtime config, not secrets. Local overrides should be reviewed carefully because the strategy config hash is part of replay lineage.

## Loader

`loadStrategyRuntimeConfig` validates all five YAML files and returns:

- typed strategy thresholds for all four active strategies;
- typed candidate-ranking weights and strategy priority;
- `strategy_config_version`;
- `strategy_config_hash`;
- canonical strategy-config JSON;
- source file paths.

When `strategy_configs.required = true`, `loadAppConfig` loads and validates the strategy config bundle during startup. Missing or invalid YAML fails fast before orchestration starts.

## Runtime Consumption

Strategy generators accept an optional `strategy_config` bundle. When provided, thresholds come from the loaded YAML surface. When omitted, the committed baseline defaults are used so unit tests and narrow pure-function callers remain deterministic.

`rankCandidates` accepts either the full strategy config bundle or an explicit ranking config override. The OBS-01 `RANK` payload still contains only journal-safe facts:

- `ranked_candidate_ids`;
- `method`.

## Validation Rules

The loader rejects:

- unsupported `version`;
- mismatched `strategy_id`;
- missing required numeric thresholds;
- unknown fields;
- non-finite numbers;
- inverted min/max ranges for trend-pullback bands;
- unsupported ranking method.

## Replay Lineage

The strategy config hash is computed from canonical sorted JSON over:

- schema version;
- all strategy parameters;
- ranking weights;
- fixed strategy priority.

Secrets and local file paths are not included in the hash.

## Known Follow-Up

`ORCH-02` must pass the loaded strategy config bundle into strategy generation and ranking so candidate and `RANK` events can carry config lineage from startup through replay.
