# QFA-612-BROKER-04-RECONCILIATION-RECOVERY-IMPL-01

STATE: PENDING-REVIEW

## Summary

Implemented broker runtime reconciliation/recovery guard behavior for the QFA-612 paper ORDER_PLANT lane.

Determination:

```text
BROKER_RECONCILIATION_RECOVERY_IMPL_READY_FOR_REVIEW
```

Substrate:

```text
origin/main@4908cc1c99bce2e01f18df31b87a562f0f953136
```

## Runtime changes

The broker adapter runtime now preserves and enforces a tighter recovery contract:

```text
idempotent_order_intent_redispatch = implemented
conflicting_duplicate_submission_ack_lineage = fails_closed
broker_reconciliation_in_progress_gate = requested during reconnect or lineage conflict
connected_reconnect_state_without_active_orders = releases reconciliation gate
connected_reconnect_state_with_unresolved_active_order = keeps reconciliation gate blocked
```

Implementation surfaces:

```text
apps/strategy_runtime/src/execution/brokers/broker-adapter-runtime.ts
apps/strategy_runtime/tests/unit/broker-adapter-integration.test.ts
```

## Guard behavior

### Idempotent redispatch

If the same `ORDER_INTENT` is dispatched after a broker correlation has already been recorded, the runtime returns the existing correlation ID instead of submitting a duplicate broker order.

If the same `ORDER_INTENT` is redispatched while the first submit is still in progress, the runtime rejects the duplicate with:

```text
duplicate_order_intent_dispatch_in_progress
```

### Duplicate submission ACK conflict

If a duplicate `ORDER_ACK_SUBMISSION` arrives with conflicting broker lineage, the runtime emits:

```text
VALIDATOR_ISSUE
validator_id = EXEC-VALIDATOR-09
code = broker_duplicate_submission_ack_lineage_conflict
severity = fatal
```

It then blocks new submissions through:

```text
broker_reconciliation_in_progress
```

### Reconnect submission gate

Reconnect-state handling now drives the existing submission gate source:

```text
broker_reconciliation_in_progress
```

Rules:

```text
RECONNECT_STATE state != CONNECTED => block submissions
RECONNECT_STATE state == CONNECTED and no active broker intents => release block
RECONNECT_STATE state == CONNECTED and unresolved active broker intent exists => keep block
```

Terminal ACKs clear the active broker-intent set only for:

```text
ORDER_ACK_CANCEL
ORDER_BROKER_REJECT
ORDER_ACK_FILL with fill_kind = FULL
```

## Tests added

Added unit coverage for:

```text
same ORDER_INTENT redispatch does not submit twice
conflicting duplicate ORDER_ACK_SUBMISSION blocks via broker_reconciliation_in_progress
reconnect blocks and releases when no active broker order remains
reconnect stays blocked when an active broker order remains unresolved
```

## Authority boundary

No broker/network action was run by this implementation package.

Preserved boundaries:

```text
no ORDER_PLANT submit/cancel run
no production account use
no live broker authority
no Phase 6 authority
no roster mutation
no marketable order authority
no fill target
no automatic shutdown flattening
no net position exposure
```

## Validation

Dependency restore:

```text
npm ci = pass
packages added = 142
npm audit = 6 vulnerabilities reported, not addressed in this scoped broker ticket
```

Validation run:

```text
npx vitest run apps/strategy_runtime/tests/unit/broker-adapter-integration.test.ts = pass, 15 tests
npm run lint --if-present = pass, forbidden import check passed, 642 files scanned
npm run build = pass
```

No broker/network action was run by validation.

## Next ticket

```text
QFA-612-BROKER-04-RECONCILIATION-RECOVERY-SMOKE-01
```

Purpose:

```text
Exercise the reconciliation/recovery guard in a bounded non-live broker runtime smoke, proving submission blocking/release behavior without submitting broker orders or creating live authority.
```
