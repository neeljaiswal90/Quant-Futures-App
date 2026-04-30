# MBO-SHADOW-EVIDENCE-02 - Repeatable Shadow Evidence Gate

## Purpose

MBO-SHADOW-EVIDENCE-02 is the repeatability gate after the first ORCH-MBO-01 smoke. It consumes a passing MBO-SHADOW-EVIDENCE-01 report and requires multiple diagnostic MBO shadow sessions before the project can move to the MBO taxonomy ADR.

This is a read-only evidence layer. It does not alter runtime trading behavior, strategy gates, ranking, risk, sizing, simulated fills, management logic, or real-order execution.

## Run

First aggregate the diagnostic sessions with MBO-SHADOW-EVIDENCE-01:

```powershell
npm run mbo:shadow:evidence -- `
  --manifest reports/rel/mbo_shadow_evidence_manifest.json `
  --out-json reports/rel/mbo_shadow_evidence_01_report.json `
  --out-md reports/rel/mbo_shadow_evidence_01_report.md
```

Then run the repeatability gate:

```powershell
npm run mbo:shadow:evidence:02 -- `
  --evidence01-report reports/rel/mbo_shadow_evidence_01_report.json `
  --out-json reports/rel/mbo_shadow_evidence_02_report.json `
  --out-md reports/rel/mbo_shadow_evidence_02_report.md `
  --min-sessions 3 `
  --ideal-sessions 5
```

## Pass Criteria

The report passes only when:

- MBO-SHADOW-EVIDENCE-01 status is `pass`.
- At least `min_sessions` diagnostic sessions are present.
- REL-00, REL-01D, and REL-01E passed for every session.
- Shadow telemetry is present in every session.
- Current MBO source journal bytes still match the source hashes recorded by MBO-SHADOW-EVIDENCE-01.
- Real-order event types are absent.
- Restricted and blocked feature uses are absent.
- `decision_use` violations are absent.
- Missing source events, lookahead source events, source hash mismatches, and recompute mismatches are absent.
- Source MBO events, action counts, side counts, order ID coverage, and sequence observations are present.
- MBO action taxonomy remains explicitly `action_taxonomy_unresolved`.

## Reported Metrics

The report summarizes:

- `session_id` and `run_id`.
- Source MBO event count.
- Shadow event count.
- Shadow field occurrence count.
- Action counts.
- Side counts.
- Order ID coverage.
- Sequence observed sessions.
- Sequence monotonic sessions.
- Sequence gap count.
- Taxonomy status.
- REL-00 / REL-01D / REL-01E pass coverage.
- Safety and lineage violation counts.

## Safety Boundary

Passing MBO-SHADOW-EVIDENCE-02 means MBO shadow telemetry is repeatable enough to proceed to taxonomy-policy review.

It does not approve:

- MBO advisory display as a trading signal.
- MBO in `STRAT_EVAL` gates.
- MBO in candidate confidence.
- MBO in ranking.
- MBO in risk or sizing.
- MBO in simulated queue-position modeling.
- Cancel/add, order-lifetime, absorption, or sweep fields as decision signals.
- Queue position.
- Real-money execution.

The next ticket after a pass is:

```text
DATA-MBO-ADR-01 - MBO action taxonomy and feature promotion policy
```
