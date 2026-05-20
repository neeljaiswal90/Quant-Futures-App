# QFA-614 paper session configuration

`paper-session-defaults.yaml` is the default paper harness configuration for
`regime_shock_reversion_short_v2`, the Cycle3 `ADVANCE_TO_PAPER` strategy.

Environment variables:

- `QFA_PAPER_SESSION_CONFIG`: optional path to a paper YAML config. The QFA-614
  runner loads this file at startup; default `config/paper/paper-session-defaults.yaml`.
- `QFA_BROKER_ADAPTER_KIND`: `mock` or `rithmic`; default `mock`.
- `QFA_METRICS_ENABLED`: enables the QFA-626 `/metrics` endpoint when `true`.
- `QFA_METRICS_PORT`: metrics port; default `9469`, bound to `127.0.0.1`.
- `QFA_PAPER_SESSION_DURATION_MS`: CLI smoke-run duration; default `3000`.
- `QFA_PAPER_SHUTDOWN_QUARANTINE_TIMEOUT_MS`: bounded wait for open quarantines
  before shutdown escalation; default comes from the YAML config.
- `RITHMIC_TEST_USERNAME`: required only when `QFA_BROKER_ADAPTER_KIND=rithmic`.
- `RITHMIC_TEST_PASSWORD`: required only when `QFA_BROKER_ADAPTER_KIND=rithmic`.
- `RITHMIC_TEST_GATEWAY_URL`: required only when `QFA_BROKER_ADAPTER_KIND=rithmic`.
- `RITHMIC_TEST_SYSTEM_NAME`: required only when `QFA_BROKER_ADAPTER_KIND=rithmic`.

The real Rithmic adapter is intentionally not wired in QFA-614. Selecting
`QFA_BROKER_ADAPTER_KIND=rithmic` fails closed with a clear
`QFA-612-PAPER-01b not yet merged` error until the sequel ticket lands after
the real-environment preflight evidence pack.
