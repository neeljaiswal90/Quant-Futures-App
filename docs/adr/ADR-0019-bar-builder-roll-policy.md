# ADR-0019: Bar builder roll policy and contract-isolated bars

## Status

Accepted

Renumbered from ADR-0016 to ADR-0019 to resolve collision with ADR-0016-qfa-611-alpha-decision-criteria.md. No content changes.

## Context

QFA-104 Session 2b completes the Phase 0 bar-builder foundation on top of the
merged DBN loader, parquet cache, and Session 2a bar-builder contracts.

The builder must emit deterministic bars while handling MNQ contract rolls
without ever mixing concrete contracts inside a single `BuiltBar`.

## Decision

The builder uses stream-derived concrete contract identity as the mechanical
roll signal.

- `instrument_id` change is the primary signal
- definition records enrich the signal with `raw_symbol` and `expiration`
- calendar fallback remains a lower-confidence policy path, but Phase 0
  streaming construction does not require it

On concrete contract change:

1. close the current accumulator before ingesting the first new-contract record
2. emit the old `BuiltBar` if active
3. emit `ContractRollBoundary`
4. start a fresh accumulator for the new contract
5. ingest the new-contract record into the new accumulator

No `BuiltBar` may contain records from more than one concrete contract.

### Time bars

Time buckets remain UTC wall-clock aligned through `deriveTimeBucket(...)`.
If a roll occurs inside a bucket, the bucket is split into two
contract-isolated bars sharing the same bucket boundaries but using distinct
bar IDs and open/close reasons.

### Event bars

Tick, volume, and dollar bars reset their accumulators at roll. No event-bar
state carries across contracts.

### OHLCV-only inputs

`ohlcv-1m` inputs can safely support:

- direct 1-minute passthrough bars
- coarser time-bar aggregation

They cannot safely support:

- subminute bars
- tick / volume / dollar bars
- intra-bucket roll splits inside an already-aggregated bucket

That final case fails closed with `roll_unsplittable_aggregate`.

### Identity and provenance

Every `BuiltBar` carries deterministic identity and objective provenance:

- `bar_id`
- `manifest_symbol_check`
- `source_metadata`
- `open_reason`
- `close_reason`
- `is_complete`
- `roll_boundary_id`

`bar_id` uses a compact UTC-second anchor because bars are bucket-aligned.
`boundary_id` keeps raw nanoseconds because roll boundaries are exact instants.

## Consequences

Positive:

- deterministic replayable bars
- no cross-contract contamination
- streaming composition with the parquet cache
- explicit failure on mechanically impossible constructions

Negative:

- OHLCV-only inputs cannot represent every roll shape
- concrete manifest expectations remain intentionally strict
- human-readable contract identity depends on definition enrichment when
  available
