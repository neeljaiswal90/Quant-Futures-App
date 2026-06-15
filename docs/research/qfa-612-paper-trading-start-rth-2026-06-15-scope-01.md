# QFA-612-PAPER-TRADING-START-RTH-2026-06-15-SCOPE-01

STATE: PENDING-REVIEW

## Determination

```text
PAPER_TRADING_START_RTH_2026_06_15_SCOPE_READY_FOR_IMPL
```

## Substrate

```text
origin/main@e4cd814c56a8c42621f6751ca6a5a8ba3d63ab2b
```

## Objective

Define the implementation contract for starting a bounded QFA paper-trading session during the 2026-06-15 RTH window using the Rithmic Test ORDER_PLANT order-placement account.

This scope does not start paper trading and does not run any broker/network action.

## Approved implementation target

Next ticket:

```text
QFA-612-PAPER-TRADING-START-RTH-2026-06-15-IMPL-01
```

The next implementation may create a dedicated launch config/script/runbook for a paper-mode session that uses:

```text
QFA_BROKER_ADAPTER_KIND = rithmic
QFA_PAPER_MARKET_DATA_SOURCE = live_rithmic_ticker_plant or explicitly scoped local/live source selected by implementation evidence
RITHMIC_TEST_* = order-placement credentials only
RITHMIC_* capture/ticker credentials = market-data only when needed
```

## Required launch preflights

The implementation must fail closed unless all of these are true:

```text
Rithmic order-placement env prefix = RITHMIC_TEST_*
RITHMIC_TEST_SYSTEM_NAME/RITHMIC_TEST_SYSTEM normalizes to Tradeify
capture credentials are not used as broker fallback
broker adapter kind = rithmic
mode = paper
plant_scope = ORDER_PLANT
live_account_allowlist entries = exactly 1
QFA_PAPER_OPERATOR_CONFIRMS_FLAT = true
QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED = true
account allowlist verification enabled unless explicitly reported otherwise
MNQ RTH calendar gate satisfied for start timestamp
broker_reconciliation_in_progress submission gate not active at startup
```

## Required runtime guardrails

The implementation must preserve:

```text
production_account_used = false
live_trading_authority_created = false
phase_6_authority_created = false
roster_mutated = false
automatic_shutdown_flattening = false
capture_credentials_mutated = false
net_position_exposure_unbounded = false
```

Paper-mode Rithmic Test order submission is permitted only through the already-validated bounded path:

```text
PaperTradingSession -> BrokerAdapterRuntimeIntegration -> PythonBrokerAdapter -> Rithmic Test ORDER_PLANT
```

## Required start artifacts

The next ticket should produce:

```text
config/paper/qfa-612-rth-2026-06-15-paper-trading.yaml or equivalent dedicated config
scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts or equivalent launch wrapper
artifacts/broker/qfa-612-paper-trading-start-rth-2026-06-15-impl-01/* launch readiness report
operator runbook/memo with exact command and stop conditions
backlog row
```

If implementation chooses not to add a persistent config file, it must explain why and still produce a reproducible launch command with resolved env/config evidence.

## Stop conditions

The launch wrapper must stop or refuse startup on:

```text
missing RITHMIC_TEST_* order-placement env
system casing not resolving to Tradeify
missing or multiple allowlisted accounts
operator flat confirmation absent
account active confirmation absent
non-RTH start unless explicitly scoped as pre-open dry run
broker_reconciliation_in_progress active before first order
ORDER_ACK_FILL observed without expected bounded paper context
net position delta cannot be proven zero or bounded
shutdown cancel cannot complete for open working order
```

## Evidence dependencies already merged

```text
PR #347 = broker adapter and paper-runtime Rithmic ORDER_INTENT submit/cancel smoke passed no fill
PR #349 = reconciliation/recovery runtime guards implemented
PR #350 = reconciliation/recovery mock smoke passed
```

## Authority caveat

This ticket is scope-only.

```text
broker_network_action_run = false
ORDER_PLANT_submit_cancel_run = false
paper_trading_started = false
production_account_used = false
live_broker_authority = false
phase_6_authority = false
roster_mutation = false
```
