# QFA-612 broker adapter cancelable-limit integration scope 01

```text
STATE: PENDING-REVIEW
```

## Ticket

```text
QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-INTEGRATION-SCOPE-01
```

## Substrate

```text
origin/main@c7d2042
```

## Purpose

Scope how the merged `PythonBrokerAdapter` / paper runtime should use the
proven Rithmic Test ORDER_PLANT cancelable-limit lifecycle while preserving
broker safety boundaries.

This ticket is scope-only. It does not modify adapter/runtime code and does
not run any broker/network action.

## Evidence anchors

| Anchor | Result |
|---|---|
| PR #340 | Broker lifecycle substrate merged |
| PR #343 | Positive-quantity cancelable-limit smoke gated on explicit account-active confirmation |
| PR #344 | Rithmic Test cancelable-limit retry evidence recorded |

Load-bearing PR #344 evidence:

```text
determination = PAPER_ORDER_PLANT_CANCELABLE_LIMIT_SMOKE_PASSED_CANCEL_RESPONSE_NO_FILL
environment = RITHMIC_TEST
system_name = Tradeify
submit_status = PASS
cancel_status = PASS
fill_event_count = 0
net_position_delta_observed_from_fill_events = 0
account_not_active_observed = false
```

## Existing integration seams

| Surface | Repo path | Symbol / function | Current role |
|---|---|---|---|
| Paper runtime broker construction | `apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts` | `PaperTradingSession.createBrokerAdapter(...)` | Instantiates `PythonBrokerAdapter` when `QFA_BROKER_ADAPTER_KIND=rithmic` |
| Order intent dispatch | `apps/strategy_runtime/src/execution/brokers/broker-adapter-runtime.ts` | `BrokerAdapterRuntimeIntegration.dispatchOrderIntent(...)` | Dispatches `ORDER_INTENT` envelopes into the selected broker adapter |
| Adapter submit | `apps/strategy_runtime/src/execution/brokers/python-broker-adapter.ts` | `PythonBrokerAdapter.submitIntent(...)` | Validates account/RTH/position caps, records lineage, sends `submit_order` IPC |
| Adapter cancel | `apps/strategy_runtime/src/execution/brokers/python-broker-adapter.ts` | `PythonBrokerAdapter.requestCancel(...)` | Sends `cancel_order` IPC for an accepted broker order |
| Account validation | `apps/strategy_runtime/src/execution/brokers/python-broker-adapter.ts` | `PythonBrokerAdapter.validateIntentAccount(...)` | Enforces account allowlist, RTH-only gate, and max position cap before IPC submit |
| Account lineage | `apps/strategy_runtime/src/execution/brokers/python-broker-adapter.ts` | `recordIntentLineage(...)`, `validateAckAccountLineage(...)` | Preserves ORDER_INTENT account lineage and rejects cross-account broker contamination |

## Scope determination

```text
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_SCOPE_READY_FOR_IMPL
```

The next implementation may wire a bounded paper-runtime / adapter smoke using
the proven Rithmic Test cancelable-limit lifecycle, but only under the explicit
safe boundaries below.

## Required implementation contract

The next implementation ticket must:

```text
use RITHMIC_TEST_* order-placement credentials only
leave capture credentials untouched
use Rithmic Test only
require QFA_BROKER_ADAPTER_KIND=rithmic
require exactly one explicit live_account_allowlist entry
require operator_confirmed_account_flat_at_session_start = true
require QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED=true for positive-quantity submit
preserve ORDER_INTENT account_id lineage
preserve account allowlist enforcement before IPC submit
preserve RTH-only account allowlist gate
preserve max_position_contracts cap
submit only a non-marketable limit order
cancel the order after working-order ACK/status lineage is observed
verify cancel response lineage
verify fill_event_count = 0
verify net_position_delta_observed_from_fill_events = 0
```

Credential split:

```text
order placement = RITHMIC_TEST_USER / RITHMIC_TEST_USERNAME / RITHMIC_TEST_PASSWORD / RITHMIC_TEST_SYSTEM / RITHMIC_TEST_SYSTEM_NAME
capture remains = RITHMIC_CONNECT_POINT / RITHMIC_SYSTEM_NAME / RITHMIC_USER / RITHMIC_PASSWORD / RITHMIC_RPROTOCOL_HOME
```

## Explicitly disallowed by next implementation

```text
production account use
live trading authority
Phase 6 authority
roster mutation
marketable order target
fill target
automatic shutdown flattening authority
order retry on uncertain submit outcome
duplicate submit after reconnect
credential value logging
raw account identifier logging
```

## Required runtime marker / event expectations

| Marker / event | Expected |
|---|---:|
| `ORDER_INTENT` | `1` bounded test intent |
| Broker submit command | `1` |
| Submit ACK / working lineage | `>= 1` |
| Broker cancel command | `1` |
| Cancel ACK / response lineage | `>= 1` |
| Fill events | `0` |
| Net position delta from observed fills | `0` |
| Automatic shutdown flatten order | `0` |
| Production account events | `0` |

## Fail-closed cases

The next implementation must fail closed before positive-quantity submit if:

```text
QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED is absent or not true
QFA_BROKER_ADAPTER_KIND is not rithmic
live_account_allowlist count is not exactly 1
operator flat-at-start confirmation is false
ORDER_INTENT lacks account_id
ORDER_INTENT account_id is not allowlisted
ORDER_INTENT timestamp is outside RTH when rth_only is set
projected account net position would exceed max_position_contracts
non-marketable price check fails
```

If submit is accepted but cancel response is not observed, the result must be
reported as blocked/inconclusive with no retry and with broker-state unknown
called out explicitly.

If any fill event is observed, the result must be:

```text
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_FAILED_UNEXPECTED_FILL
```

## Recommended next ticket

```text
QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-INTEGRATION-IMPL-01
```

Expected success determination:

```text
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_PASSED_CANCEL_RESPONSE_NO_FILL
```

Approved blocker / failure determinations:

```text
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_BLOCKED_ACCOUNT_ACTIVE_GATE
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_BLOCKED_ALLOWLIST_GATE
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_BLOCKED_RTH_GATE
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_BLOCKED_NON_MARKETABLE_PRICE_GUARD
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_BLOCKED_SUBMIT_ACK
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_BLOCKED_CANCEL_ACK
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_FAILED_UNEXPECTED_FILL
BROKER_ADAPTER_CANCELABLE_LIMIT_INTEGRATION_INCONCLUSIVE
```

## Authority caveat

This scope does not create production account use, live broker authority, Phase
6 authority, roster mutation, marketable order authority, fill target,
automatic shutdown flattening authority, or net position exposure.

