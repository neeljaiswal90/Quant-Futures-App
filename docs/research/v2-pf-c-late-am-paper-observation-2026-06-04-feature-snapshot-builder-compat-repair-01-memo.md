# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-COMPAT-REPAIR-01 memo

## Summary

```text
FEATURE_SNAPSHOT_BUILDER_COMPAT_REPAIR_EMITTED_INSTRUMENT_READY_SNAPSHOT
```

This ticket repairs the PR #321 2026-06-04 source-backed snapshot compatibility gap found by the candidate strat-eval smoke: the v2 strategy reads `snapshot.instrument.tick_size`, but the PR #321 snapshot did not materialize `instrument`.

The repaired snapshot adds MNQ instrument lineage only. It does not run strategy runtime and creates no observation-day or broker/live authority.

## Consumer compatibility

```json
[
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "created_ts_ns",
    "source_ready_anchor": "PR #321 source-backed snapshot timestamp",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "quote.mid_px",
    "source_ready_anchor": "PR #321 source-backed quote mid",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "session.is_rth",
    "source_ready_anchor": "PR #321 session readiness",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "session.is_halt",
    "source_ready_anchor": "PR #321 halt readiness",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "session.is_roll_block",
    "source_ready_anchor": "PR #321 roll readiness",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "indicators.sigma_pts",
    "source_ready_anchor": "PR #321 sigma source readiness",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "context.regime_label",
    "source_ready_anchor": "PR #321 scoped regime label",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "context.signed_shock_vwap.value",
    "source_ready_anchor": "PR #321 signed-shock source value",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "config.config_hash",
    "source_ready_anchor": "PR #321 variant config hash",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "config.config_version",
    "source_ready_anchor": "PR #321 variant config version",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "instrument.tick_size",
    "source_ready_anchor": "MNQ instrument lineage mirrored from prior source-backed builder artifacts",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "instrument.point_value",
    "source_ready_anchor": "MNQ instrument lineage mirrored from prior source-backed builder artifacts",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "instrument.price_decimals",
    "source_ready_anchor": "MNQ instrument lineage mirrored from prior source-backed builder artifacts",
    "value_present": true
  },
  {
    "consumer_status": "READY",
    "placeholder_used": false,
    "snapshot_field_path": "instrument.symbol",
    "source_ready_anchor": "MNQM6 source/capture contract identity",
    "value_present": true
  }
]
```

## Authority caveat

```json
{
  "paper_runtime_invoked": false,
  "STRAT_EVAL": 0,
  "CANDIDATE": 0,
  "ORDER_INTENT": 0,
  "observation_day_eligible": false,
  "observation_day_increment": 0,
  "qfa_410b_or_qfa_611_run": false,
  "broker_live_authorized": false,
  "phase_6_authorized": false,
  "active_candidate_roster_mutated": false,
  "global_regime_labels_mutated": false
}
```
