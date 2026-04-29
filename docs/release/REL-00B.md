# REL-00B - Release Evidence Index

Status: implemented

## Scope

`REL-00B` builds a deterministic release evidence index from existing INFRA, DATA, SIM, and REL reports. It does not run live market access, replay sessions, or execution simulation. It also does not embed raw probe rows, Databento DBN files, decoded JSONL observations, or journal payload lines.

Run:

```powershell
npm run rel:00b:evidence-index
```

The command writes:

```text
reports/rel/rel00b_evidence_index.json
reports/rel/rel00b_evidence_index.md
```

## Inputs

The default input root is `reports/`. Missing optional reports produce warnings rather than crashes. Required SIM-03L/SIM-03D and REL-00A evidence drives the final readiness classification.

Useful flags:

```powershell
npm run rel:00b:evidence-index -- `
  --reports-root reports `
  --out-json reports/rel/rel00b_evidence_index.json `
  --out-md reports/rel/rel00b_evidence_index.md
```

## Status Meaning

- `ready_for_rel00_candidate`: REL-00A passed and SIM-03D passed the robust SIM-03L calibration report. REL-00/REL-01 still have to run.
- `partial`: required or useful evidence is missing, but no hard failure was observed.
- `blocked`: at least one required evidence report failed.

## Boundary

Passing REL-00B does not mark REL-00 or REL-01 complete. It only summarizes whether the evidence packet is coherent enough to start REL-00 candidate review.

REL-01 still requires controlled run evidence, replay determinism on the accepted data surface, final traceability spot-checks, and respect for remaining DATA-01B/MBO restrictions.
