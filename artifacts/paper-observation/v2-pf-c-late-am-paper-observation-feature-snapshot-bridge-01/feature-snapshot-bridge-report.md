# V2 PF C late-AM feature-snapshot bridge report

Ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-SNAPSHOT-BRIDGE-01`

Classification: `FEATURE_SNAPSHOT_BRIDGE_BLOCKED_EVIDENCE_GAP`

## Bounded source input

- Source OBS path: `D:\Quant-futures-app\tools\rithmic_analytics\data\captures\2026-06-01\MNQ_globex.obs01.jsonl`
- Full source SHA-256: `fcc527711650293c6877a0d5c0c5ebf9cc64032d4d893aa5f55fc5b5f5d4bae9`
- Full source SHA scope: `point_in_time_full_file`
- Bounded OBS replay LF SHA-256: `52e14d4d72251031886ceb7ce76f1ec2cdd94deef81f7002a5c4ce44d2a42ac6`
- Bounded OBS replay event count: 120
- Source event counts: TRADE=120

## Feature-snapshot bridge

- Decision: `blocked_missing_required_fields`
- Feature snapshot payload source: `not_materialized_blocked_missing_required_fields`
- Bounded feature snapshot LF SHA-256: `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570`
- Bounded feature snapshot count: 0
- Snapshots attempted/emitted/rejected: 0/0/0

Missing required context:

- `capture_quote_context`
- `capture_backed_strategy_feature_snapshot_builder`
- `capture_backed_vix_value`
- `capture_backed_vix_fresh`
- `capture_backed_vix_prior_close_percentile`
- `capture_backed_signed_shock_vwap`
- `capture_backed_signed_shock_vwap_recent_values`
- `capture_backed_regime_label`
- `capture_backed_primary_percentile`
- `capture_backed_vxn_percentile`
- `capture_backed_spread_queue_context`
- `capture_backed_bar_context`

## Causality

- Status: `not_evaluated_no_snapshots_emitted`
- Source event range start: `1780265045352387457`
- Source event range end: `1780265053785788825`
- Future event count used: 0

## Runtime markers

- Event counts: SESSION_MANIFEST=2
- STRAT_EVAL: 0
- CANDIDATE: 0
- ORDER_INTENT: 0

## Observation-day decision

- Observation-day eligible: false
- Observation-day increment: 0

This monitor verifies bridge/control evidence only. It does not count toward the 45/60 paper-observation day requirement.

## Next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-BUILDER-SCOPE-01`

## Authority

- Broker/live authorized: false
- Phase 6 authorized: false
- Active roster mutated: false
- Candidate roster mutated: false
