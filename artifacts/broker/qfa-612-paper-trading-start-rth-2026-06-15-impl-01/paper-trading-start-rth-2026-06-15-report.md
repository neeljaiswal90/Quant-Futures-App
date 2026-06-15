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
| RITHMIC_TEST_GATEWAY_URL_present | BLOCKED | false |
| RITHMIC_TEST_SYSTEM_NAME_is_Tradeify | PASS | "Tradeify" |
| capture_credentials_not_broker_fallback | BLOCKED | "requires explicit RITHMIC_TEST_GATEWAY_URL/RITHMIC_TEST_WS_URL" |
| QFA_PAPER_OPERATOR_CONFIRMS_FLAT_true | BLOCKED | false |
| QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED_true | BLOCKED | false |
| allowlist_path_present | BLOCKED | false |
| allowlist_count_exactly_one | BLOCKED | "unavailable" |
| rth_gate | PASS | {"allow_preopen":true,"is_rth":false,"phase":"eth","trading_date":"2026-06-15"} |
| start_duration_required | PASS | "not_starting" |

## Launch command

```powershell
npx tsx scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts --preflight-only --allow-preopen
```

## Boundary

This wrapper is paper-mode Rithmic Test only. Capture credentials are not broker fallback. No production account, live trading authority, Phase 6 authority, roster mutation, automatic shutdown flattening, or capture credential mutation is authorized.

## Output hashes

```text
bounded_jsonl_lf_sha256 = c815765b1e431efe06aaea4f85c1cbb1cfc2a4c840c3f09d674916e9b52cc0c6
report_json_lf_sha256 = 53e66bed97b91396d1790330fd7d86e804e9f7627fdd8d2de558183ecf09ec56
```
