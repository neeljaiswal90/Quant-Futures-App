# QFA-612-BROKER-04-RECONCILIATION-RECOVERY-SMOKE-01

## Determination

```text
BROKER_RECONCILIATION_RECOVERY_SMOKE_PASSED_MOCK_GUARDS
```

## Scenario results

| Scenario | Result | Details |
|---|---|---|
| idempotent_redispatch | PASS | {"adapter_submit_count":1,"first_accepted":true,"same_correlation_id":true,"second_accepted":true} |
| conflicting_duplicate_submission_ack | PASS | {"gate_allowed":false,"gate_reason":"broker_reconciliation_in_progress_active","validator_code":"broker_duplicate_submission_ack_lineage_conflict"} |
| reconnect_release_without_active_order | PASS | {"blocked_allowed":false,"blocked_reason":"broker_reconciliation_in_progress_active","released_allowed":true} |
| reconnect_keeps_blocked_with_active_order_then_releases_after_cancel | PASS | {"active_gate_allowed":false,"active_gate_reason":"broker_reconciliation_in_progress_active","cancel_accepted":true,"released_gate_allowed_after_cancel":true} |

## Boundary

This smoke uses a scripted mock BrokerAdapter only. It does not run ORDER_PLANT, Rithmic, broker network, submit/cancel, production account, live authority, Phase 6 authority, or roster mutation.

## Output hashes

```text
bounded_jsonl_lf_sha256 = 30c1589fbef95724a2855564b90b4837039914bad3b1ead11d62c69271897eb5
report_json_lf_sha256 = 26bed09e838681639f21bde54c9ac10d0d0e1305060d2230c0cae1d07778be8c
```
