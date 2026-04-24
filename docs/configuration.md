# APP-03 Configuration

APP-03 defines the typed application config surface for the TypeScript strategy runtime.

## Local Setup

Do not commit local config files that contain machine-specific paths or credentials. Start from the public example:

```powershell
Copy-Item config/app.example.json config/local.app.json
$env:QFA_CONFIG = "config/local.app.json"
```

`config/local*.json`, `config/*.local.json`, and secret config files are ignored by git.

## Public Config

The public runtime config is JSON and is safe to hash into replay lineage. It includes:

- runtime mode, which must be `simulation` for V1;
- MNQ/CME instrument identity;
- public data provider choices, `rithmic` for live market data and `databento` for historical/replay;
- replay seed and config-hash enforcement;
- journal/data paths;
- a future strategy-config surface pointing at `config/strategies` YAML files.

Strategy tuning YAML is intentionally not implemented in APP-03. `strategy_configs.required` should stay `false` until STRAT-07 lands the typed strategy config files.

## Secrets

Secrets are resolved from environment variables only and are not included in the public config hash:

- `DATABENTO_API_KEY`
- `RITHMIC_USERNAME`
- `RITHMIC_PASSWORD`
- `RITHMIC_SYSTEM_NAME`
- `RITHMIC_APP_NAME`

The loader returns `publicConfig`, `secrets`, `lineage`, and `source` separately so startup code can validate configuration without leaking credentials into journals or replay lineage.

## Public Environment Overrides

These environment variables override public config fields before validation and hashing:

- `QFA_APP_ENV`
- `QFA_LOG_LEVEL`
- `QFA_RUNTIME_MODE`
- `QFA_INSTRUMENT`
- `QFA_EXCHANGE`
- `QFA_RUNTIME_TIMEZONE`
- `QFA_LIVE_DATA_PROVIDER`
- `QFA_HISTORICAL_DATA_PROVIDER`
- `QFA_EXECUTION_ADAPTER`
- `QFA_REPLAY_SEED`
- `QFA_REQUIRE_CONFIG_HASH_MATCH`
- `QFA_JOURNAL_DIR`
- `QFA_DATA_DIR`
- `QFA_STRATEGY_CONFIG_DIR`
- `QFA_STRATEGY_CONFIG_FORMAT`
- `QFA_REQUIRE_STRATEGY_CONFIGS`

The resulting config hash changes when public overrides change. Secret-only changes do not change the config hash.
