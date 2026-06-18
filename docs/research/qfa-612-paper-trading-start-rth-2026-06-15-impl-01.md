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
bounded_jsonl_lf_sha256 = 7f52b8a20c5206ee93211c6fb54a9867a6541e6271e8d0f35cf71040a7434a64
report_json_lf_sha256 = d05dd493e5dc8bd445e400ce078003780b9e7a89783e643a10ca6ac4ce31fdb1
report_md_lf_sha256 = 49056f2af9d8bf25aa8b6cec8d79b31b116fc757c328f3bb5ea97c74da678ad4
```
