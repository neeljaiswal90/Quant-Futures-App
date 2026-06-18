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
bounded_jsonl_lf_sha256 = d99f5d192f295bd0bba98a308b7f6f1e45bfdba5b8ecab767121f018fb190e9e
report_json_lf_sha256 = c02775d22ebd90c0e0b74f0109376e4df4eba32ea9a687bc2857513d0787f343
report_md_lf_sha256 = de3d5d7139270fc50bd24dadb6b316b2dd0b066dc6c6a56024c8d44c47bff867
```
