# REL-01D: Feature Surface Audit

REL-01D is a read-only audit for controlled live-sim runtime journals. It proves which
feature fields appeared in decision and non-decision feature surfaces, using the DATA-03-PS
feature availability mask.

REL-01D does not run strategies, alter risk, place orders, promote MBO, or mark REL-01
complete. It indexes field names, tiers, contexts, paths, hashes, and counts only.

## Inputs

REL-01D consumes the REL-01A manifest shape:

```powershell
npm run rel:01d:feature-surface-audit -- `
  --manifest reports/rel/rel01_manifest.json `
  --out-json reports/rel/rel01d_feature_surface_audit.json `
  --out-md reports/rel/rel01d_feature_surface_audit.md
```

Each manifest session must include:

- `session_id`
- `run_id`
- `journal`

REL-01D reads current journal bytes directly. It does not trust prior REL-00 or REL-01A
reports for field usage.

## Audit Mask

The audit binds to DATA-03-PS:

- `mask_version = 4`
- `mask_id = feature-availability-mask-v4-adr0002-data03ps-mbo-shadow`

If a journal event embeds a `feature_availability_mask`, REL-01D fails on any mismatch
against the audit mask. Older journals that do not embed a mask object can still be audited;
the report records how many feature-surface events had missing embedded masks.

## Context Rules

REL-01D distinguishes these contexts:

- `values`: runtime decision feature surface on `FEATURES` and `MICROSTRUCTURE` events.
- `decision_payload`: known feature fields found directly in decision lifecycle events such
  as `STRAT_EVAL`, `CANDIDATE`, `RANK`, `RISK_GATE`, `SIZING`, `ORDER_INTENT`, and `SIM_FILL`.
- `diagnostic_values`: non-decision diagnostic telemetry.
- `shadow_values`: non-decision shadow telemetry.

Decision contexts must be authoritative-only.

Diagnostic telemetry must be `diagnostic_only` and must have `decision_use=false`.

Shadow telemetry must be `shadow_only` and must have `decision_use=false`.

Blocked fields fail anywhere, including shadow and diagnostic contexts.

## Report Partitions

REL-01D reports usage frequency by partition:

- `authoritative`
- `diagnostic`
- `shadow`
- `restricted`
- `blocked`
- `invalid_diagnostic`
- `invalid_shadow`
- `unknown`

`unknown` fields are reported for operator visibility but are not automatically a failure;
they may be strategy-internal indicators. Known non-authoritative fields in decision
contexts are `restricted` and fail the audit.

## Failure Conditions

REL-01D fails if:

- any referenced journal is missing;
- any journal has malformed JSONL lines;
- an embedded feature mask disagrees with the v4 audit mask;
- a blocked field appears anywhere;
- a `subscope`, `diagnostic_only`, or `shadow_only` field appears in `values` or a decision
  payload;
- a `diagnostic_values` field is not `diagnostic_only`;
- a `shadow_values` field is not `shadow_only`;
- diagnostic or shadow payloads omit explicit `decision_use=false`.

## Output

Default outputs:

- `reports/rel/rel01d_feature_surface_audit.json`
- `reports/rel/rel01d_feature_surface_audit.md`

The report does not embed raw market data, feature values, order payload values, DBN files,
or journal payloads.

## Relationship To REL-01E

REL-01D proves the accepted feature-surface boundary across runtime journals. REL-01E should
build on this by validating MBO shadow telemetry provenance after a producer starts emitting
`shadow_values`. MBO decision-use remains blocked until a later policy explicitly promotes
specific fields.
