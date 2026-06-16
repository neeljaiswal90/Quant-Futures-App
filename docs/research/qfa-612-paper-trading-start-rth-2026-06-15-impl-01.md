# QFA-612-PAPER-TRADING-START-RTH-2026-06-15-IMPL-01

STATE: PENDING-REVIEW

Determination:

```text
PAPER_TRADING_START_RTH_2026_06_15_STARTED_AND_STOPPED_BOUNDED
```

This implementation adds a dedicated 2026-06-15 RTH paper-trading config and a fail-closed launch wrapper. Default mode is preflight-only; actual paper start requires --start, --duration-ms, RTH unless explicitly allowed, RITHMIC_TEST_* order-placement env, explicit gateway, exactly one allowlisted account, flat-at-start confirmation, account-active confirmation, and a readable live_local_capture_tail OBS source.

The live capture feature bridge uses a compact full-session minute-bar seed built from OBS01 before start, uses bounded recent-tail MBP1 quote seeding for operator start speed, and does not replay historical records through strategy runtime. This grants full-session VWAP authority through the seed source offset plus live tail, but does not grant observation-day or order-translation authority.

Authority boundary remains: no production account, no live broker authority, no Phase 6 authority, no roster mutation, no capture credential mutation, and no automatic shutdown flattening.

Output hashes:

```text
bounded_jsonl_lf_sha256 = 82e2f368e20c162f342d79638ff6eb742e01cbbf3e76db03618cd997b5fb696a
report_json_lf_sha256 = 9d08455645ac935c7e4e053c425de9384d8e0a11d7c34462e2bc12f53c74f19e
report_md_lf_sha256 = 75e1a63154a7acf168f76df11e95b8a76333500d81edc39d426cd6cf84a8f791
```
