# QFA-612-PAPER-TRADING-START-RTH-2026-06-15-IMPL-01

STATE: PENDING-REVIEW

Determination:

```text
PAPER_TRADING_START_RTH_2026_06_15_STARTED_AND_STOPPED_BOUNDED
```

This implementation adds a dedicated 2026-06-15 RTH paper-trading config and a fail-closed launch wrapper. Default mode is preflight-only; actual paper start requires --start, --duration-ms, RTH unless explicitly allowed, RITHMIC_TEST_* order-placement env, explicit gateway, exactly one allowlisted account, flat-at-start confirmation, account-active confirmation, and a readable live_local_capture_tail OBS source.

The live capture feature bridge uses bounded recent-tail OBS01/MBP1 seeding for operator start speed, warms indicator state without replaying historical tail records through strategy runtime, and only proves fresh live-capture strategy evaluation. It does not grant full-session VWAP authority, observation-day authority, or order-translation authority.

Authority boundary remains: no production account, no live broker authority, no Phase 6 authority, no roster mutation, no capture credential mutation, and no automatic shutdown flattening.

Output hashes:

```text
bounded_jsonl_lf_sha256 = 4b5cb1d7fa40f9b3da04a41655cec386da19f8b5634db191c4b0825fb083066c
report_json_lf_sha256 = d9d79d50f213eef39e28b5adaedb5569347f169e13d17f5609b786b1ff169900
report_md_lf_sha256 = 9504097f345c2fee744e4f145cff7596e6a79215686509a0bdb577ce76f07a45
```
