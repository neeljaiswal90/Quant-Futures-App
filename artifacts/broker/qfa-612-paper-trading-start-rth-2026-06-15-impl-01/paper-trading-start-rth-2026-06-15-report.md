# QFA-612-PAPER-TRADING-START-RTH-2026-06-15-IMPL-01

## Determination

```text
PAPER_TRADING_START_RTH_2026_06_15_PREFLIGHT_BLOCKED_MISSING_LAUNCH_GATES
```

## Gates

| Gate | Status | Detail |
|---|---|---|
| RITHMIC_TEST_USERNAME_present | PASS | true |
| RITHMIC_TEST_PASSWORD_present | PASS | true |
| RITHMIC_TEST_GATEWAY_URL_present | PASS | true |
| RITHMIC_TEST_SYSTEM_NAME_is_Tradeify | PASS | "Tradeify" |
| capture_credentials_not_broker_fallback | PASS | "requires explicit RITHMIC_TEST_GATEWAY_URL/RITHMIC_TEST_WS_URL" |
| market_data_source_is_live_local_capture_tail | PASS | "live_local_capture_tail" |
| live_capture_tail_path_present | PASS | true |
| live_capture_tail_path_exists | PASS | "D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-15/MNQ_globex.obs01.jsonl" |
| live_capture_tail_path_nonempty | PASS | 73769574 |
| QFA_PAPER_OPERATOR_CONFIRMS_FLAT_true | PASS | true |
| QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED_true | PASS | true |
| allowlist_path_present | PASS | true |
| allowlist_count_exactly_one | PASS | 1 |
| rth_gate | BLOCKED | {"allow_preopen":false,"is_rth":false,"phase":"eth","trading_date":"2026-06-16"} |
| start_duration_required | PASS | "not_starting" |

## Launch command

```powershell
npx tsx scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts --preflight-only --allow-preopen
```

## Boundary

This wrapper is paper-mode Rithmic Test only. Capture credentials are not broker fallback. No production account, live trading authority, Phase 6 authority, roster mutation, automatic shutdown flattening, or capture credential mutation is authorized.

## Output hashes

```text
bounded_jsonl_lf_sha256 = c4c091820e79657f0ac0d312eccdcf50d8382d0b63c7e37d5ed0e1640897346c
report_json_lf_sha256 = dcd73ebf2d1a27e63fd93a1404661a78a4efae46fd7c629dadae3d0680f135de
```
