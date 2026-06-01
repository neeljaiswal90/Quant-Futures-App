# V2-PF-C-LATE-AM-PAPER-OBSERVATION-MONITOR-01 capture health report

## Classification

`CAPTURE_HEALTH_ONLY_NOT_OBSERVATION_DAY`

This monitor verifies market-data capture health only. It does not count toward the 45/60 paper-observation day requirement unless strategy-runtime evidence is present.

## Process status

| Check | Result |
|---|---|
| Rithmic refresh loop running | true |
| Refresh loop PID | 30320 |
| Realtime backend running | true |
| Realtime backend PID | 22024 |
| Strategy runtime process detected | false |

## Capture files

| File | Size bytes | Last write |
|---|---:|---|
| Raw capture | 3259855580 | 2026-06-01T06:50:52.695Z |
| Normalized obs01 | 92374122 | 2026-06-01T06:50:49.460Z |

Growth over 5s: raw +716670 bytes, obs01 +21906 bytes.

## Stream presence

| Stream/payload | Present |
|---|---|
| L1_QUOTE | true |
| BestBidOffer | true |
| MBO | true |
| DepthByOrder | true |

## Normalized obs01

Estimated normalized event count: 236238.

| Sample | Count |
|---|---:|
| `TRADE` in tail sample | 3 |

## Derived analytics freshness

| Artifact | Size bytes | Last write |
|---|---:|---|
| Zones | 3666 | 2026-06-01T06:50:24.363Z |
| Probability card | 2697 | 2026-06-01T06:50:40.139Z |
| Absorption | 24934 | 2026-06-01T06:50:40.125Z |

## Dashboard refresh

Latest daily_zones end: 2026-05-31 23:50:40 END   daily_zones globex exit=0

Latest refresh complete: 2026-05-31 23:50:40 DONE  refresh complete; normalize and daily_zones preserved; v1_html=retired

Warnings in latest log tail:

- 2026-05-31 23:39:43,169 WARNING --trading-date 2026-06-01 is operator override of an INCOMPLETE day; processing partial capture
- 2026-05-31 23:39:59,808 INFO RITHMIC_DISCORD_WEBHOOK_URL not set; FAIL alert push disabled. Set it in your .env to enable Discord notifications.
- 2026-05-31 23:45:01,423 WARNING --trading-date 2026-06-01 is operator override of an INCOMPLETE day; processing partial capture
- 2026-05-31 23:45:22,456 INFO RITHMIC_DISCORD_WEBHOOK_URL not set; FAIL alert push disabled. Set it in your .env to enable Discord notifications.
- 2026-05-31 23:50:23,104 WARNING --trading-date 2026-06-01 is operator override of an INCOMPLETE day; processing partial capture
- 2026-05-31 23:50:40,141 INFO RITHMIC_DISCORD_WEBHOOK_URL not set; FAIL alert push disabled. Set it in your .env to enable Discord notifications.

## Strategy marker scan

| Source | Strategy markers |
|---|---|
| `D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-01/MNQ_globex.jsonl` | none |
| `D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-01/MNQ_globex.obs01.jsonl` | none |
| `D:/Quant-futures-app/tools/rithmic_analytics/data/zones/2026-06-01_MNQ_globex.json` | none |
| `D:/Quant-futures-app/tools/rithmic_analytics/data/probability_cards/2026-06-01_MNQ_globex.json` | none |
| `D:/Quant-futures-app/tools/rithmic_analytics/data/absorption/2026-06-01_MNQ_globex.json` | none |
| `D:/Quant-futures-app/tools/rithmic_dashboard/data/dashboard/local_probe_refresh_2026-05-31.log` | none |

False-positive guard note: Initial broad process matching can catch the monitor command itself; final classification requires actual strategy markers or a bona fide paper runtime process, neither of which was present.

## Observation-day eligibility

Observation-day eligible: `false`.

Observation-day increment: `0`.

## Next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-LIVE-CAPTURE-BRIDGE-01` remains separate and is required before market-data capture can become strategy paper-observation evidence.

## SHA

| Artifact | SHA-256 |
|---|---|
| `capture-health-report.json` | `45ec5476d3f3a320d2a0cf42bc6ff537c4afff2149f5949670d47cdba25b074b` |
