# MBO-SHADOW-EVIDENCE-01 - Aggregate MBO Shadow Telemetry Evidence

## Purpose

MBO-SHADOW-EVIDENCE-01 aggregates diagnostic MBO shadow telemetry across one or more live-sim diagnostic sessions. It proves repeatability of the shadow telemetry lane without promoting any MBO-derived field to decision-use.

This is a read-only evidence layer. It does not alter runtime trading behavior, strategy gates, ranking, risk, sizing, simulated fills, or management logic.

## Inputs

Run the aggregator with a manifest:

```powershell
npm run mbo:shadow:evidence -- `
  --manifest reports/rel/mbo_shadow_evidence_manifest.json `
  --out-json reports/rel/mbo_shadow_evidence_report.json `
  --out-md reports/rel/mbo_shadow_evidence_report.md
```

Manifest shape:

```json
{
  "schema_version": 1,
  "evidence_run_id": "mbo-shadow-evidence-20260429",
  "runtime_commit": "optional git commit",
  "sessions": [
    {
      "session_id": "2026-04-29-shadow-smoke",
      "run_id": "orch-mbo01-smoke-20260429-211947",
      "shadow_journal": "reports/rel/orch_mbo01_smoke_20260429_211947/diagnostic_current_main/rel00_controlled_live_sim_shadow_journal.jsonl",
      "mbo_source_journal": "reports/rel/orch_mbo01_smoke_20260429_211947/data01b_mbo_order_lifecycle.obs01.jsonl",
      "orch_report": "reports/rel/orch_mbo01_smoke_20260429_211947/diagnostic_current_main/orch_mbo_01_shadow_producer_report.json",
      "rel00_report": "reports/rel/orch_mbo01_smoke_20260429_211947/diagnostic_current_main/rel00_shadow_report.json",
      "rel01d_report": "reports/rel/orch_mbo01_smoke_20260429_211947/diagnostic_current_main/rel01d_shadow_report.json",
      "rel01e_report": "reports/rel/orch_mbo01_smoke_20260429_211947/diagnostic_current_main/rel01e_shadow_lineage_report.json"
    }
  ]
}
```

## Required Evidence

Each session must provide:

- ORCH-MBO-01 report with `status = generated`.
- REL-00 report with `status = pass`.
- REL-01D report with `status = pass`.
- REL-01E report with `status = pass`.
- Shadow journal containing non-zero `shadow_values`.
- MBO source journal whose bytes hash-bind to the producer and lineage reports.

## Aggregated Metrics

The report summarizes:

- Source MBO event count.
- MBO action counts.
- MBO side counts.
- Mask version, mask id, and mask hash consistency across REL-01D and REL-01E reports.
- Shadow event count.
- Shadow field occurrence count.
- Cross-validator agreement between the local shadow-journal scan, REL-01D shadow partition count, and REL-01E lineage count.
- Per-field distribution statistics for `cancel_add_ratio_shadow`, `mbo_action_imbalance_shadow`, and `order_lifetime_shadow`.
- Source hash coverage.
- REL-00 / REL-01D / REL-01E pass coverage.
- Decision-use, restricted-use, blocked-use, missing-source, lookahead, and recompute-mismatch counts.

The report intentionally does not embed raw MBO rows, raw source windows, raw journal payloads, or DBN data.

## Pass Criteria

The aggregate status is `pass` only when:

- At least one session is present.
- Every referenced file exists and parses.
- ORCH-MBO-01 generated every session.
- REL-00, REL-01D, and REL-01E passed every session.
- Shadow telemetry is present.
- REL-01D and REL-01E agree on the same mask binding.
- The local shadow-journal scan, REL-01D, and REL-01E agree on shadow field occurrence counts.
- Real-order event types are absent.
- Restricted and blocked feature uses are absent.
- `decision_use` violations are absent.
- Missing source events, lookahead source events, source hash mismatches, and recompute mismatches are absent.

## Safety Boundary

Passing MBO-SHADOW-EVIDENCE-01 means MBO shadow telemetry is repeatable enough for diagnostic collection.

For promotion-path evidence, run MBO-SHADOW-EVIDENCE-02 after collecting at least three diagnostic sessions. MBO-SHADOW-EVIDENCE-02 consumes this report, enforces the multi-session minimum, and keeps the next step as DATA-MBO-ADR-01 rather than decision-use.

The JSON report stamps this posture explicitly:

```json
{
  "safety_posture": {
    "mbo_decision_use_allowed": false,
    "mbo_derived_features_status": "shadow_only",
    "data01b_full_status": "blocked",
    "runtime_trading_behavior_changed": false,
    "decision_surface_changed": false,
    "execution_mode": "unchanged_simulated_only"
  }
}
```

It does not approve:

- MBO in `STRAT_EVAL` gates.
- MBO in candidate confidence.
- MBO in ranking.
- MBO in risk or sizing.
- MBO in simulated queue-position modeling.
- Cancel/add, order-lifetime, absorption, or sweep fields as decision signals.
- Real-money execution.
