# QFA-612-PAPER-TRADING-START-RTH-2026-06-15-IMPL-01

## Determination

```text
PAPER_TRADING_START_RTH_2026_06_15_STARTED_AND_STOPPED_BOUNDED
```

## Gates

| Gate | Status | Detail |
|---|---|---|
| RITHMIC_TEST_USERNAME_present | PASS | true |
| RITHMIC_TEST_PASSWORD_present | PASS | true |
| RITHMIC_TEST_GATEWAY_URL_present | PASS | true |
| RITHMIC_TEST_SYSTEM_NAME_is_Tradeify | PASS | "Tradeify" |
| RITHMIC_RPROTOCOL_HOME_present | PASS | true |
| RITHMIC_RPROTOCOL_HOME_exists | PASS | "D:\\Quant-futures-app\\.local\\rithmic\\RProtocolAPI_extracted\\0.89.0.0" |
| capture_credentials_not_broker_fallback | PASS | "requires explicit RITHMIC_TEST_GATEWAY_URL/RITHMIC_TEST_WS_URL" |
| market_data_source_is_live_local_capture_tail | PASS | "live_local_capture_tail" |
| live_capture_tail_path_present | PASS | true |
| live_capture_tail_path_exists | PASS | "D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-16/MNQ_globex.obs01.jsonl" |
| live_capture_tail_path_nonempty | PASS | 791438823 |
| live_capture_tail_recent | PASS | 171.53369140625 |
| live_capture_mbp1_path_exists | PASS | "D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-16/MNQ_globex.mbp1.jsonl" |
| live_capture_mbp1_recent | PASS | 161.51904296875 |
| paper_observation_stop_after_candidate_enabled | PASS | true |
| live_capture_feature_bridge_enabled | PASS | true |
| QFA_PAPER_OPERATOR_CONFIRMS_FLAT_true | PASS | true |
| QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED_true | PASS | true |
| allowlist_path_present | PASS | true |
| allowlist_count_exactly_one | PASS | 1 |
| rth_gate | PASS | {"allow_preopen":false,"is_rth":true,"phase":"rth","trading_date":"2026-06-16"} |
| start_duration_required | PASS | 60000 |

## Launch command

```powershell
npx tsx scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts --start --duration-ms 60000
```

## Boundary

This wrapper is paper-mode Rithmic Test only. Capture credentials are not broker fallback. No production account, live trading authority, Phase 6 authority, roster mutation, automatic shutdown flattening, or capture credential mutation is authorized.

## Live capture feature bridge contract

The bridge uses bounded recent-tail OBS01/MBP1 seeding for operator start speed, warms indicator state without replaying historical tail records through strategy runtime, and only proves fresh live-capture strategy evaluation. It does not grant full-session VWAP authority, observation-day authority, or order-translation authority.

## Output hashes

```text
bounded_jsonl_lf_sha256 = 4b5cb1d7fa40f9b3da04a41655cec386da19f8b5634db191c4b0825fb083066c
report_json_lf_sha256 = d9d79d50f213eef39e28b5adaedb5569347f169e13d17f5609b786b1ff169900
```
