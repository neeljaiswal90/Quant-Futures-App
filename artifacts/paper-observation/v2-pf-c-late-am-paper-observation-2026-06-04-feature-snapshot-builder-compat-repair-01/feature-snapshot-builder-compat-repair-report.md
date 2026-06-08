# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-COMPAT-REPAIR-01

## Determination

```text
FEATURE_SNAPSHOT_BUILDER_COMPAT_REPAIR_EMITTED_INSTRUMENT_READY_SNAPSHOT
```

## Repair summary

| Field | Value |
|---|---|
| feature_snapshot_id | `feature-v2pf-20260604-1780585080000000000` |
| strategy_feature_snapshot_count | `1` |
| repaired_field_family | `instrument` |
| instrument.tick_size | `0.25` |
| instrument.symbol | `MNQM6` |
| ready_for_candidate_strat_eval_smoke_rerun | `true` |

## Consumer compatibility

| Snapshot field path | Value present | Placeholder used | Source-ready anchor | Consumer status |
|---|---:|---:|---|---|
| `created_ts_ns` | `true` | `false` | PR #321 source-backed snapshot timestamp | `READY` |
| `quote.mid_px` | `true` | `false` | PR #321 source-backed quote mid | `READY` |
| `session.is_rth` | `true` | `false` | PR #321 session readiness | `READY` |
| `session.is_halt` | `true` | `false` | PR #321 halt readiness | `READY` |
| `session.is_roll_block` | `true` | `false` | PR #321 roll readiness | `READY` |
| `indicators.sigma_pts` | `true` | `false` | PR #321 sigma source readiness | `READY` |
| `context.regime_label` | `true` | `false` | PR #321 scoped regime label | `READY` |
| `context.signed_shock_vwap.value` | `true` | `false` | PR #321 signed-shock source value | `READY` |
| `config.config_hash` | `true` | `false` | PR #321 variant config hash | `READY` |
| `config.config_version` | `true` | `false` | PR #321 variant config version | `READY` |
| `instrument.tick_size` | `true` | `false` | MNQ instrument lineage mirrored from prior source-backed builder artifacts | `READY` |
| `instrument.point_value` | `true` | `false` | MNQ instrument lineage mirrored from prior source-backed builder artifacts | `READY` |
| `instrument.price_decimals` | `true` | `false` | MNQ instrument lineage mirrored from prior source-backed builder artifacts | `READY` |
| `instrument.symbol` | `true` | `false` | MNQM6 source/capture contract identity | `READY` |

## Authority locks

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

## Recommended next ticket

```text
V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-CANDIDATE-STRAT-EVAL-SMOKE-RERUN-01
```
