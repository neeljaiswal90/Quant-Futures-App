# RSRCH-00: 2017+ MNQ/NQ Historical Continuity Policy

Status: implemented

## Purpose

RSRCH-00 makes the 2017+ Databento research-history policy explicit. MNQ is the V1 canonical instrument, but MNQ history may not cover the full 2017+ window. The runtime and research tools must therefore never silently mix MNQ and NQ rows.

This ticket defines policy, types, config, lineage, and validation only. It does not fetch Databento data and does not implement the RSRCH-01 historical loader.

## Config

The policy lives at:

```text
config/research/historical-continuity.yaml
```

The loader is:

```text
apps/strategy_runtime/src/research/historical-continuity.ts
```

The YAML uses the project strict subset: named maps, two-space indentation, scalar values, no arrays, no anchors, no flow syntax, and no inline comments after values.

## Historical Domains

`MNQ_CANONICAL` is the canonical V1 research domain. It is used for MNQ contract symbols at or after the configured MNQ canonical start timestamp. Launch gates and MNQ-only performance claims must use this domain.

`NQ_SURROGATE_PRE_MNQ` is the only allowed pre-MNQ surrogate domain. It uses NQ rows before MNQ canonical availability, must carry `surrogate_for: MNQ`, and must be reported separately from canonical MNQ metrics.

No dataset manifest may represent NQ rows as MNQ canonical data. No manifest may mix both domains without explicitly segmenting the rows and recording each segment's lineage.

## Normalization Policy

The V1 normalization policy is:

```text
tick_r_volatility_v1
```

NQ surrogate rows must be normalized before any cross-domain use:

- price distances and spread-like fields into tick units using the source contract metadata;
- stop, target, and outcome distances into R units where candidate risk is available;
- volatility features into sigma/ATR-style normalized units;
- cost and point-value-sensitive fields must retain their original contract context and must not be treated as MNQ economics.

NQ surrogate data can support pretraining, priors, and sanity checks. It cannot hide weak MNQ-only performance and cannot satisfy MNQ launch activity floors.

## Required Dataset Lineage

Every research/replay dataset manifest that uses this policy must record:

- `continuity_policy_id`
- `continuity_policy_version`
- `continuity_policy_hash`
- `instrument_root`
- `contract_symbol`
- `domain`
- `surrogate_for`
- `normalization_policy`
- `source_provider`
- `exchange_event_ts_ns_basis`

The only valid `source_provider` for this V1 policy is `databento`. The timestamp basis must be `exchange_event_ts_ns`, consistent with ADR-0001.

## Loader Behavior

`loadHistoricalContinuityPolicy()` loads and validates the committed policy. It returns canonical JSON and a SHA-256 `continuity_policy_hash` for manifest lineage.

`buildResearchDatasetContinuityLineage()` selects the domain from caller-provided `exchange_event_ts_ns`:

- timestamps before `mnq_canonical_start_ts_ns` resolve to `NQ_SURROGATE_PRE_MNQ`;
- timestamps at or after `mnq_canonical_start_ts_ns` resolve to `MNQ_CANONICAL`.

The helper validates that contract symbols match the selected domain:

- `MNQ_CANONICAL` requires `instrument_root: MNQ`, `surrogate_for: none`, and an `MNQ...` contract symbol.
- `NQ_SURROGATE_PRE_MNQ` requires `instrument_root: NQ`, `surrogate_for: MNQ`, and an `NQ...` contract symbol.

## DATA/RSRCH Consumption

RSRCH-01 must use this policy while building Databento datasets from 2017 onward. It should record the continuity lineage in every reproducible manifest and should split outputs by historical domain when a requested window crosses the MNQ availability boundary.

RSRCH-03 must report performance by historical domain. REL-01 launch acceptance remains MNQ-first: NQ surrogate history may inform priors and sanity checks, but MNQ-only history is the primary acceptance basis.

## Deferred

- RSRCH-01: verify actual Databento MNQ coverage and implement the historical loader.
- RSRCH-03: report candidate counts and performance separately by `MNQ_CANONICAL` and `NQ_SURROGATE_PRE_MNQ`.
- REL-01: enforce that NQ surrogate metrics do not satisfy MNQ-only launch floors.
