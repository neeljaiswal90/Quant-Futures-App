# QFA-612-PAPER-RUNTIME-RITHMIC-ORDER-INTENT-SMOKE-01

## Determination

```text
PAPER_RUNTIME_RITHMIC_ORDER_INTENT_SMOKE_PASSED_SUBMIT_CANCEL_NO_FILL
```

## Paper runtime smoke result

| Field | Value |
|---|---|
| ORDER_INTENT count | 1 |
| ORDER_ACK_SUBMISSION count | 1 |
| ORDER_ACK_CANCEL count | 1 |
| cancel accepted | true |
| fill_event_count | 0 |
| net_position_delta_observed_from_fill_events | 0 |
| selected account hash | c1acb9ddc55ab10663183a4707897e1673b98e1f8278f0d725a0effae882b11b |
| local bid/ask | 30211.75 / 30212.5 |
| limit price | 30161.75 |

## Boundary

- Uses RITHMIC_TEST_* order-placement credentials only.
- Maps to RITHMIC_LUCID_* only inside the broker sidecar process.
- Capture credentials were not modified and are not broker fallback.
- PaperTradingSession was invoked, but strategy authority, production account use, live trading authority, Phase 6 authority, and roster mutation remain false.
- Non-marketable BUY LIMIT only; no fill target; cancel required.

## Output hashes

```text
bounded_jsonl_lf_sha256 = 924bef570851110ddbc2204dbe0d9cdd0efbe44ea612a3523acd00e6d56b65ca
report_json_lf_sha256 = f276d97721ce437a5be0532cd2161ae85d237f0ff909a980f2653509c6d0cb36
```
