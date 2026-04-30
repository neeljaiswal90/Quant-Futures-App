# REL-01E: MBO Shadow Lineage Validation

REL-01E is a read-only validator for MBO shadow telemetry. REL-01D answers
"which feature fields appeared, and were they in the right tier/context?"
REL-01E answers the next question: "did every MBO shadow field come from
source MBO data that existed at or before the shadow event timestamp?"

REL-01E does not enable MBO decision use, does not place orders, and does not
change runtime behavior.

## Command

```powershell
npm run rel:01e:mbo-shadow-lineage -- `
  --manifest reports/rel/rel01_manifest.json `
  --out-json reports/rel/rel01e_mbo_shadow_lineage_report.json `
  --out-md reports/rel/rel01e_mbo_shadow_lineage_report.md
```

The manifest follows the REL-01A shape and extends each session that contains
MBO shadow telemetry with:

```json
{
  "session_id": "2026-04-29-rth",
  "run_id": "rel01-live-sim-20260429",
  "journal": "reports/rel/rel01_20260429/rel00_controlled_live_sim_journal.jsonl",
  "rel00_report": "reports/rel/rel01_20260429/rel00_controlled_live_sim_report.json",
  "rel00c_report": "reports/rel/rel01_20260429/rel00c_controlled_live_sim_generation_report.json",
  "mbo_source_journal": "reports/rel/rel01_20260429/data01b_mbo_order_lifecycle.obs01.jsonl",
  "mbo_source_journal_sha256": "optional-expected-source-hash"
}
```

Current REL-00C journals do not emit `shadow_values`, so REL-01E will report
`status: no_shadow_telemetry` until a producer such as ORCH-MBO-01 emits
lineage-rich MBO shadow fields.

## Required Shadow Lineage

Every event with populated `shadow_values` must also include:

```json
{
  "decision_use": false,
  "mbo_shadow_lineage": {
    "schema_version": 1,
    "source_journal_sha256": "<sha256 of mbo_source_journal>",
    "fields": {
      "cancel_add_ratio_shadow": {
        "derivation_method": "mbo_cancel_add_ratio_v1",
        "source_event_ids": ["mbo-src-1", "mbo-src-2"],
        "source_window_start_ts_ns": "1777301421588943700",
        "source_window_end_ts_ns": "1777301421589943700"
      }
    }
  }
}
```

The validator checks that every source event id exists in the hash-bound MBO
source journal and that no source event timestamp is later than the shadow event
timestamp. This catches fabricated shadow telemetry and look-ahead bias.

## Supported Derivations

REL-01E currently recomputes these action-derived shadow fields:

- `cancel_add_ratio_shadow` with `mbo_cancel_add_ratio_v1`
- `mbo_action_imbalance_shadow` with `mbo_action_imbalance_v1`
- `order_lifetime_shadow` with `mbo_order_lifetime_mean_ms_v1`

`absorption_score_shadow` and `sweep_score_shadow` remain unsupported until a
producer and explicit derivation contract are landed. If either appears before
that contract exists, REL-01E fails closed.

## Status Values

- `pass`: shadow telemetry exists and all lineage, causality, and recomputation
  checks pass.
- `fail`: shadow telemetry or inputs violate lineage policy.
- `no_shadow_telemetry`: the packet contains no `shadow_values`; this is not a
  pass for MBO shadow evidence.

## No Raw Data

The report contains paths, hashes, counts, field names, derivation methods, and
event identifiers only. It does not embed raw MBO records, market-data payload
values, shadow payload values, DBN files, or runtime journal payloads.
