# V2 PF C late-AM live-capture bridge report

Ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-LIVE-CAPTURE-BRIDGE-01`

Classification: `LOCAL_OBS_REPLAY_BRIDGE_CONTROL_ONLY_NOT_OBSERVATION_DAY`

## Source OBS

- Path: `D:\Quant-futures-app\tools\rithmic_analytics\data\captures\2026-06-01\MNQ_globex.obs01.jsonl`
- SHA-256: `5fd8b6e2ec2cb241bc29446dd753b9003f160522704ca84685de4ddf9265b0f2`
- Sampled events: 120
- Source event counts: TRADE=120
- Full source SHA scope: `point_in_time_full_file`
- Bounded replay LF SHA-256: `52e14d4d72251031886ceb7ce76f1ec2cdd94deef81f7002a5c4ce44d2a42ac6`
- Bounded replay event count: 120

Review anchor fields:

```json
{
  "sha256_scope": "point_in_time_full_file",
  "bounded_replay_lf_sha256": "52e14d4d72251031886ceb7ce76f1ec2cdd94deef81f7002a5c4ce44d2a42ac6",
  "bounded_replay_event_count": 120,
  "future_marker_classification": "PAPER_RUNTIME_MARKERS_PRESENT_BRIDGE_ONLY_NOT_OBSERVATION_DAY"
}
```

## Dedicated paper runtime

- Strategy: `regime_shock_reversion_short_v2_utc_16_18_exclusion`
- Config: `config/paper/v2-pf-c-late-am-paper-observation.yaml`
- Adapter: `mock`
- Market data source: `local_obs_replay`

## Runtime event counts

- Total events: 122
- Counts: SESSION_MANIFEST=2, TRADE=120
- STRAT_EVAL: 0
- CANDIDATE: 0
- ORDER_INTENT: 0

## Interpretation

- Normalized Rithmic OBS JSONL can be consumed by the dedicated paper runtime through local_obs_replay with mock order-plant isolation.
- The bridge emits source QUOTE/TRADE journal events but does not create feature snapshots by itself.
- This bounded bridge smoke run never awards observation-day credit; any runtime markers must be routed to a later full-duration daily report or monitor ticket.

## Observation-day decision

Observation-day eligible: false

Observation-day increment: 0

This bridge verifies local replay ingestion of normalized capture events into the dedicated paper runtime. It does not count toward the 45/60 paper-observation requirement unless strategy-runtime evidence is present.

## Next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-SNAPSHOT-BRIDGE-01`

## Authority

- Broker/live authorized: false
- Phase 6 authorized: false
- Active roster mutated: false
- Candidate roster mutated: false
