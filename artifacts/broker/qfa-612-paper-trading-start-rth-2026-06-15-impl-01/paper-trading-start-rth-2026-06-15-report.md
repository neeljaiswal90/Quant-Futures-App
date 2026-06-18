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
| live_capture_tail_path_exists | PASS | "D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-18/MNQ_globex.obs01.jsonl" |
| live_capture_tail_path_nonempty | PASS | 608629809 |
| live_capture_tail_recent | PASS | 271.00390625 |
| live_capture_mbp1_path_exists | PASS | "D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-18/MNQ_globex.mbp1.jsonl" |
| live_capture_mbp1_recent | PASS | 254.45849609375 |
| live_capture_minute_bar_seed_path_present | PASS | "D:\\qfa612-live-capture-full-session-seed-01\\.tmp\\qfa-612-live-capture-minute-bar-seed\\2026-06-18-MNQ_globex.minute-bars.seed.json" |
| live_capture_minute_bar_seed_path_exists | PASS | "D:\\qfa612-live-capture-full-session-seed-01\\.tmp\\qfa-612-live-capture-minute-bar-seed\\2026-06-18-MNQ_globex.minute-bars.seed.json" |
| live_capture_minute_bar_seed_source_matches_obs01 | PASS | "D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-18/MNQ_globex.obs01.jsonl" |
| live_capture_minute_bar_seed_source_size_covered | PASS | 608602440 |
| live_capture_minute_bar_seed_has_warmup | PASS | 109 |
| live_capture_minute_bar_seed_starts_at_rth_open | PASS | 0 |
| paper_observation_stop_after_candidate_enabled | PASS | true |
| live_capture_feature_bridge_enabled | PASS | true |
| QFA_PAPER_OPERATOR_CONFIRMS_FLAT_true | PASS | true |
| QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED_true | PASS | true |
| allowlist_path_present | PASS | true |
| allowlist_count_exactly_one | PASS | 1 |
| rth_gate | PASS | {"allow_preopen":false,"is_rth":true,"phase":"rth","trading_date":"2026-06-18"} |
| start_duration_required | PASS | 60000 |

## Launch command

```powershell
npx tsx scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts --start --duration-ms 60000
```

## Boundary

This wrapper is paper-mode Rithmic Test only. Capture credentials are not broker fallback. No production account, live trading authority, Phase 6 authority, roster mutation, automatic shutdown flattening, or capture credential mutation is authorized.

## Live capture feature bridge contract

The bridge uses a compact full-session minute-bar seed built from OBS01 before start, uses bounded recent-tail MBP1 quote seeding for operator start speed, and does not replay historical records through strategy runtime. This grants full-session VWAP authority through the seed source offset plus live tail, but does not grant observation-day or order-translation authority.

## Output hashes

```text
bounded_jsonl_lf_sha256 = 7f52b8a20c5206ee93211c6fb54a9867a6541e6271e8d0f35cf71040a7434a64
report_json_lf_sha256 = d05dd493e5dc8bd445e400ce078003780b9e7a89783e643a10ca6ac4ce31fdb1
```
