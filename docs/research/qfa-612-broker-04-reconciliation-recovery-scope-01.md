# QFA-612-BROKER-04-RECONCILIATION-RECOVERY-SCOPE-01

STATE: PENDING-REVIEW

## Determination

```text
BROKER_RECONCILIATION_RECOVERY_SCOPE_READY_FOR_IMPL
```

## Substrate

```text
origin/main@5055482f6d872a60dab4ca9411b8a3b22461d512
```

Merged prerequisite evidence:

```text
PR #340 = broker lifecycle substrate merged
PR #344 = Rithmic Test cancelable-limit retry evidence merged
PR #345 = broker adapter cancelable-limit integration scope merged
PR #346 = broker adapter cancelable-limit integration impl merged
PR #347 = broker adapter smoke + paper-runtime ORDER_INTENT smoke merged
```

Most recent proof:

```text
QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-SMOKE-01 = PASSED_SUBMIT_CANCEL_NO_FILL
QFA-612-PAPER-RUNTIME-RITHMIC-ORDER-INTENT-SMOKE-01 = PASSED_SUBMIT_CANCEL_NO_FILL
ORDER_ACK_SUBMISSION = 1
ORDER_ACK_CANCEL = 1
fill_event_count = 0
net_position_delta_observed_from_fill_events = 0
```

## ADR basis

ADR-0018-A1 defines Phase 4 as:

```text
QFA-612-BROKER-04 = Reconciliation + recovery: restart cycle, idempotency cache, divergence resolution, broker_reconciliation_in_progress gate source.
```

This ticket scopes Phase 4 only. It does not implement Phase 4 and does not authorize Phase 5 safety validators or Phase 6 paper-trading capstone behavior.

## Current runtime seams

Primary implementation surfaces:

```text
apps/strategy_runtime/src/execution/brokers/broker-adapter-runtime.ts
apps/strategy_runtime/src/execution/brokers/broker-adapter.ts
apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts
```

Current state-bearing surfaces to preserve and extend:

```text
BrokerAdapterRuntimeIntegration.intentsByEventId
BrokerAdapterRuntimeIntegration.correlationIdByIntentEventId
BrokerAdapterRuntimeIntegration.brokerOrderIdByIntentEventId
BrokerAdapterRuntimeIntegration.accountIdByIntentEventId
BrokerAdapterRuntimeIntegration.ackTimeoutTimersByIntentEventId
BrokerAdapter.subscribeAckEvents(...)
BrokerAdapter.subscribeSessionEvents(...)
PaperTradingSession.reconnectBrokerAdapter(...)
PaperTradingSession.handleOperationalSessionEvent(...)
SubmissionGate
```

Existing event surfaces:

```text
SESSION_MANIFEST
RECONNECT_STATE
VALIDATOR_ISSUE
ORDER_ACK_SUBMISSION
ORDER_ACK_CANCEL
ORDER_ACK_FILL
ORDER_BROKER_REJECT
ORDER_QUARANTINE_ENTERED
ORDER_QUARANTINE_CLEARED
```

## Required implementation contract for next ticket

Next implementation ticket:

```text
QFA-612-BROKER-04-RECONCILIATION-RECOVERY-IMPL-01
```

Must implement or prove the following without live authority expansion:

1. Restart-cycle recovery contract

```text
adapter/session disconnect or restart must emit RECONNECT_STATE lineage
submissions must be blocked while broker_reconciliation_in_progress is true
reconnect completion must re-enter CONNECTED/RECOVERING deterministically
recovery failure must remain fail-closed and leave submission blocked
```

2. Idempotency cache contract

```text
order_intent_id is the primary runtime idempotency key
broker_intent_correlation_id is remembered after accepted submit
broker_order_id and broker_account_id are remembered only from ORDER_ACK_SUBMISSION
re-dispatch of an already-submitted intent must not submit a duplicate order
cancel retry must use remembered broker_order_id and account_id only after ACK lineage exists
missing lineage must continue to emit VALIDATOR_ISSUE broker_cancel_missing_submission_lineage
```

3. Divergence-resolution contract

```text
unknown broker order state blocks new submissions
duplicate or conflicting ACK lineage blocks new submissions
broker session restart with unresolved active order lineage enters reconciliation-in-progress
terminal ACKs may clear reconciliation only when runtime lineage is complete and net position safety remains known
unexpected fill or position exposure must fail closed and must not auto-flatten
```

4. Submission-gate source contract

```text
broker_reconciliation_in_progress must be an explicit submission-gate source
source must be visible in diagnostics / session events / report evidence
source must be cleared only after deterministic reconciliation completion
```

5. No-authority contract

```text
no production account use
no live trading authority
no Phase 6 authority
no roster mutation
no marketable order authority
no automatic shutdown flattening authority
no fill target
no broker/live promotion authority
```

## Required fail-closed cases for next implementation

```text
cancel before ORDER_ACK_SUBMISSION lineage remains rejected
restart while an order is submitted but not terminal enters broker_reconciliation_in_progress
duplicate ORDER_ACK_SUBMISSION for same intent with conflicting broker_order_id blocks submission
ORDER_ACK_CANCEL without known submission lineage blocks submission and emits validator issue
ORDER_ACK_FILL during reconciliation blocks submission and requires explicit operator review
broker session reconnect failure leaves submission blocked
credentials unavailable during reconnect leaves submission blocked
adapter reports malformed session or ACK event leaves submission blocked
```

## Expected tests for next implementation

No live broker/network test is required for the implementation ticket. Use mock adapter/session event injection first.

Required scoped tests:

```text
broker_reconciliation_in_progress blocks dispatch
reconnect completion can clear broker_reconciliation_in_progress only after no unresolved active order remains
same ORDER_INTENT is not submitted twice after restart/replay
cancel retry after remembered ACK lineage uses broker_order_id and account_id
conflicting duplicate ACK lineage emits VALIDATOR_ISSUE and blocks submission
unexpected fill during reconciliation fails closed and does not auto-flatten
```

Optional follow-up after implementation merge:

```text
QFA-612-BROKER-04-RECONCILIATION-RECOVERY-SMOKE-01
```

Purpose: bounded non-production smoke of reconnect/recovery behavior, still Rithmic Test only, still no live authority, still no Phase 6 authority, still no roster mutation.

## Implementation explicitly not authorized here

```text
no code changes in this ticket
no broker/network action run
no ORDER_PLANT submit/cancel run
no PaperTradingSession live run
no production account use
no Phase 5 validator implementation
no Phase 6 paper trading capstone
no live pilot
```

## Recommended next ticket

```text
QFA-612-BROKER-04-RECONCILIATION-RECOVERY-IMPL-01
```
