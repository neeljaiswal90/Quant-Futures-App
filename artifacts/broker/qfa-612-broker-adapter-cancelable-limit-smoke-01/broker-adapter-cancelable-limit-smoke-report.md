# QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-SMOKE-01

## Determination

```text
BROKER_ADAPTER_CANCELABLE_LIMIT_SMOKE_PASSED_SUBMIT_CANCEL_NO_FILL
```

## Broker adapter smoke result

| Field | Value |
|---|---|
| submit accepted | true |
| cancel accepted | true |
| fill_event_count | 0 |
| net_position_delta_observed_from_fill_events | 0 |
| selected account hash | c1acb9ddc55ab10663183a4707897e1673b98e1f8278f0d725a0effae882b11b |
| local bid/ask | 30194.25 / 30195.25 |
| limit price | 30144.25 |

## Boundary

- Uses RITHMIC_TEST_* order-placement credentials only.
- Maps to RITHMIC_LUCID_* only inside the broker sidecar process.
- Capture credentials were not modified and are not broker fallback.
- Production account use, live trading authority, Phase 6 authority, and roster mutation remain false.
- Non-marketable BUY LIMIT only; no fill target; cancel required.

## Output hashes

```text
bounded_jsonl_lf_sha256 = bf390f0856d3a84ecb2f6760bd866430582d95e114695af191122106c1b23dee
report_json_lf_sha256 = 1a0ee829fa77aeb4b4325cdc0e40efb4f3ffaa5eee6b8bb297cfc799fcd27c48
```
