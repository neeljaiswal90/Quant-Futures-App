# QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-SMOKE-01

STATE: PENDING-REVIEW

## Determination

```text
BROKER_ADAPTER_CANCELABLE_LIMIT_SMOKE_PASSED_SUBMIT_CANCEL_NO_FILL
```

## Scope

Ran a bounded Rithmic Test broker-adapter cancelable-limit smoke through PythonBrokerAdapter and BrokerAdapterRuntimeIntegration.

## Evidence

- submit accepted: true
- cancel accepted: true
- fill_event_count: 0
- net_position_delta_observed_from_fill_events: 0
- local quote source hash: c6ae37c6c0836d659dc3ed1a7a5919e71d0de390035dedb67b7d1dec25b71831
- limit price: 30144.25

## Authority caveat

No production account use, no live trading authority, no Phase 6 authority, no roster mutation, no marketable order authority, no fill target, no automatic shutdown flattening authority, and no net position exposure created.

## Output hashes

```text
bounded_jsonl_lf_sha256 = bf390f0856d3a84ecb2f6760bd866430582d95e114695af191122106c1b23dee
report_json_lf_sha256 = 1a0ee829fa77aeb4b4325cdc0e40efb4f3ffaa5eee6b8bb297cfc799fcd27c48
report_md_lf_sha256 = 4895363f83735a5ecf0d5fb266aae4c62c5edc6530a7e4d98d0626ae612c893b
```
