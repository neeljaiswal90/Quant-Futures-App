# QFA-612 broker adapter cancelable-limit integration impl 01

```text
STATE: PENDING-REVIEW
```

## Ticket

```text
QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-INTEGRATION-IMPL-01
```

## Substrate

```text
origin/main@299b238
PR #345 mergeCommit = 299b2389b977f81a3bf0cf82248b1fae0de7e6bc
```

## Determination

```text
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_IMPL_READY_FOR_REVIEW_NO_BROKER_ACTION_RUN
```

## Implementation summary

This implementation wires the paper-runtime broker adapter path toward the proven
Rithmic Test cancelable-limit lifecycle without executing a broker/network probe.

Load-bearing changes:

```text
BrokerAdapterRuntimeIntegration remembers broker_order_id and broker_account_id from ORDER_ACK_SUBMISSION.
BrokerAdapterRuntimeIntegration enriches cancel requests with broker_order_id and account_id before adapter.requestCancel(...).
BrokerAdapterRuntimeIntegration fails closed with VALIDATOR_ISSUE before adapter.requestCancel(...) when broker_order_id or broker account lineage is missing.
BrokerCancelRequest carries optional broker_order_id and account_id.
PythonBrokerAdapter fails closed before positive-quantity IPC submit unless QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED=true.
PaperTradingSession Rithmic adapter construction maps RITHMIC_TEST_* order-placement envs into the sidecar LUCID aliases.
PaperTradingSession no longer falls back from order-placement credentials to capture credentials for Rithmic adapter construction.
```

## Guard contract

```text
use RITHMIC_TEST_* order-placement credentials only = true
capture credentials untouched = true
require exactly one live_account_allowlist entry = preserved from PR #340/#345 substrate
require operator flat-at-start confirmation = preserved from PR #340/#345 substrate
require QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED=true = true
preserve RTH gate = true
preserve account allowlist gate = true
preserve ORDER_INTENT account lineage = true
submit non-marketable limit only = delegated to bounded smoke harness / operator-selected limit basis
cancel required = runtime cancel path now carries broker_order_id needed for cancel
fill_event_count target = 0
net_position_delta target = 0
```

## Code provenance

| Contract | Repo path | Symbol / function | Implementation |
|---|---|---|---|
| Submit account-active gate | `apps/strategy_runtime/src/execution/brokers/python-broker-adapter.ts` | `PythonBrokerAdapter.validateIntentAccount(...)` | Blocks positive-quantity submit unless `QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED=true` |
| Submit lineage | `apps/strategy_runtime/src/execution/brokers/python-broker-adapter.ts` | `recordIntentLineage(...)` | Preserves originating `ORDER_INTENT.account_id` |
| Cancel broker order id | `apps/strategy_runtime/src/execution/brokers/broker-adapter-runtime.ts` | `rememberSubmissionAck(...)` | Stores `broker_order_id` and `broker_account_id` from submit ACK |
| Cancel request enrichment | `apps/strategy_runtime/src/execution/brokers/broker-adapter-runtime.ts` | `requestCancel(...)` | Passes `broker_order_id` and `account_id` into adapter cancel request |
| Cancel fail-closed guard | `apps/strategy_runtime/src/execution/brokers/broker-adapter-runtime.ts` | `emitCancelLineageValidatorIssue(...)` | Emits `broker_cancel_missing_submission_lineage` and does not call `adapter.requestCancel(...)` when lineage is missing |
| Credential split | `apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts` | `createBrokerAdapter(...)` | Maps `RITHMIC_TEST_*` into sidecar env and does not fall back to capture envs |
| Credential alias normalization | `apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts` | `normalizeOrderPlantCredentialEnv(...)` | Supports `RITHMIC_TEST_USER`/`RITHMIC_TEST_USERNAME`, `RITHMIC_TEST_SYSTEM`/`RITHMIC_TEST_SYSTEM_NAME`, and `RITHMIC_TEST_WS_URL`/`RITHMIC_TEST_GATEWAY_URL` without capture fallback |
| Credential presence guard | `apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts` | `assertOrderPlantCredentialEnvPresent(...)` | Requires explicit `RITHMIC_TEST_USERNAME`, `RITHMIC_TEST_PASSWORD`, `RITHMIC_TEST_GATEWAY_URL`, and `RITHMIC_TEST_SYSTEM_NAME` equivalents before constructing the Rithmic adapter |

## Required order-placement env set

```text
RITHMIC_TEST_USERNAME or RITHMIC_TEST_USER
RITHMIC_TEST_PASSWORD
RITHMIC_TEST_GATEWAY_URL or RITHMIC_TEST_WS_URL
RITHMIC_TEST_SYSTEM_NAME or RITHMIC_TEST_SYSTEM
QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED=true
```

Capture credentials remain untouched and are not used as broker order-placement
fallback:

```text
RITHMIC_CONNECT_POINT
RITHMIC_SYSTEM_NAME
RITHMIC_USER
RITHMIC_PASSWORD
RITHMIC_RPROTOCOL_HOME
```

## No-action caveat

```text
broker_network_action_run = false
ORDER_PLANT_submit_run = false
ORDER_PLANT_cancel_run = false
marketable_order_run = false
fill_target_run = false
validation_run_by_this_packet = false
```

This ticket is the adapter/runtime wiring implementation. The actual Rithmic
Test adapter smoke should remain a separate explicitly authorized run ticket.

## Expected local validation

Recommended scoped checks before PR readiness:

```powershell
npx vitest run apps/strategy_runtime/tests/unit/python-broker-adapter.test.ts apps/strategy_runtime/tests/unit/broker-adapter-integration.test.ts
npm run lint --if-present
```

Do not run a real ORDER_PLANT submit/cancel smoke until the next explicitly
authorized broker-smoke ticket.

## Authority caveat

```text
production_account_use = false
live_broker_authority = false
Phase_6_authority = false
roster_mutation = false
marketable_order_authority = false
fill_target = false
automatic_shutdown_flattening = false
net_position_exposure = false
```

## Recommended next ticket

```text
QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-SMOKE-01
```

Purpose:

```text
Run the newly wired PythonBrokerAdapter / paper-runtime cancelable-limit path in Rithmic Test only, using RITHMIC_TEST_* order-placement credentials, a non-marketable limit order, explicit cancel, zero fills, and zero net position delta.
```
