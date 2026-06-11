# QFA-614 paper session configuration

`paper-session-defaults.yaml` is the default paper harness configuration for
`regime_shock_reversion_short_v2`, the Cycle3 `ADVANCE_TO_PAPER` strategy.

Environment variables:

- `QFA_PAPER_SESSION_CONFIG`: optional path to a paper YAML config. The QFA-614
  runner loads this file at startup; default `config/paper/paper-session-defaults.yaml`.
- `QFA_BROKER_ADAPTER_KIND`: `mock` or `rithmic`; default `mock`.
- `QFA_PAPER_MARKET_DATA_SOURCE`: `simulation`, `live_rithmic_ticker_plant`, or
  `local_obs_replay`; default `simulation`. All sources keep `mode=paper`.
  When `QFA_BROKER_ADAPTER_KIND=rithmic`, the broker path uses the paper
  ORDER_PLANT adapter and requires a single configured live account allowlist
  entry plus explicit flat-at-start operator confirmation.
- `QFA_PAPER_LOCAL_OBS_PATH`: required only when
  `QFA_PAPER_MARKET_DATA_SOURCE=local_obs_replay`; points at an OBS-01 JSONL file
  containing `QUOTE` / `TRADE` events.
- `QFA_PAPER_LOCAL_OBS_PACE_MODE`: `realtime` or `as_fast_as_possible`;
  default `realtime`.
- `QFA_METRICS_ENABLED`: enables the QFA-626 `/metrics` endpoint when `true`.
- `QFA_METRICS_PORT`: metrics port; default `9469`, bound to `127.0.0.1`.
- `QFA_PAPER_SESSION_DURATION_MS`: CLI smoke-run duration; default `3000`.
- `QFA_PAPER_SHUTDOWN_QUARANTINE_TIMEOUT_MS`: bounded wait for open quarantines
  before shutdown escalation; default comes from the YAML config.
- `QFA_PAPER_LIVE_ACCOUNT_ALLOWLIST_PATH`: optional JSON allowlist path.
- `QFA_PAPER_OPERATOR_CONFIRMS_FLAT`: must be `true` when
  `QFA_BROKER_ADAPTER_KIND=rithmic`; confirms the operator has verified the
  allowlisted account is flat before startup. Programmatic reconciliation lands
  in QFA-612-BROKER-04.
- The QFA-612-BROKER-03 adapter does not auto-flatten positions on shutdown.
  Any flatten/reconciliation authority remains deferred to the next broker
  reconciliation ticket.
- `QFA_PAPER_LIVE_ACCOUNT_VERIFICATION_DISABLE`: optional explicit bypass for
  boot-time account-list verification; unset means verification is enabled.
- `QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED`: optional preflight-only gate for
  the real Rithmic Test cancelable-limit smoke. It must be `true` before the
  preflight attempts a positive-quantity working-order candidate; otherwise the
  check records `HOLD` before submit. The default when absent is blocked
  (`false`); the accepted value is case-insensitive `true` after trimming
  whitespace; every other value is blocked. This does not create broker/live
  authority and does not bypass the account allowlist or flat-at-start checks.
- `RITHMIC_LUCID_USER` / `RITHMIC_USER`: required only when
  `QFA_BROKER_ADAPTER_KIND=rithmic`.
- `RITHMIC_LUCID_PASSWORD` / `RITHMIC_PASSWORD`: required only when
  `QFA_BROKER_ADAPTER_KIND=rithmic`.
- `RITHMIC_LUCID_GATEWAY` / `RITHMIC_CONNECT_POINT`: required only when
  `QFA_BROKER_ADAPTER_KIND=rithmic`.
- `RITHMIC_LUCID_SYSTEM_NAME` / `RITHMIC_SYSTEM_NAME`: required only when
  `QFA_BROKER_ADAPTER_KIND=rithmic`.
- `RITHMIC_USER`: required only when
  `QFA_PAPER_MARKET_DATA_SOURCE=live_rithmic_ticker_plant`; scoped to
  TICKER_PLANT market-data access.
- `RITHMIC_PASSWORD`: required only for the live ticker source.
- `RITHMIC_CONNECT_POINT`: required only for the live ticker source.
- `RITHMIC_SYSTEM_NAME`: required only for the live ticker source.

QFA-612-BROKER-03 wires the paper ORDER_PLANT adapter for LUCIDFLEX eval use.
The adapter still fails closed unless the allowlist is configured, exactly one
account is selected, and the flat-at-start confirmation flag is set.
