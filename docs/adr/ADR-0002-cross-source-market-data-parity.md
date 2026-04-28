# ADR-0002: Cross-Source Market-Data Parity For V1

## Status

Accepted

## Context

V1 uses Rithmic as the live market-data provider and Databento as the historical,
research, and replay provider. INFRA-01 requires evidence that live Rithmic capture and
Databento historical data reconstruct comparable MNQ market state before L2/L3 work can
advance.

DATA-PARITY-08 triangulated the post04D MBP10 evidence:

- Rithmic reconstructed `MBP10` top-of-book vs Rithmic reconstructed `L1_QUOTE`: 99.647858%
  both-side top price within one MNQ tick.
- Databento `mbp-10` top-of-book vs Databento `mbp-1`: 99.965621%.
- Rithmic reconstructed `L1_QUOTE` vs Databento `mbp-1`: 96.92945%.
- Rithmic reconstructed `MBP10` top-of-book vs Databento `mbp-10`: 95.993782%.

This shows both providers are internally consistent above 99.5%, while the remaining
cross-source top-of-book disagreement is the same order of magnitude for L1 and MBP10.
The residual mismatch is therefore classified as provider/rendering variance, not an
extraction failure.

## Decision

For V1, Rithmic remains the canonical live market-data provider.

Databento remains the canonical historical, replay, and research provider.

`exchange_event_ts_ns` remains the canonical event time for all market-data parity,
replay, feature-alignment, and lineage decisions. Receive timestamps remain telemetry only,
as defined by ADR-0001.

Cross-source MBP10 price-state agreement around 96% is accepted for the V1 MBP10
price-state sub-scope when all of the following are true:

- Rithmic internal MBP10/L1 agreement is at least 99.5%.
- Databento internal MBP10/MBP-1 agreement is at least 99.5%.
- Temporal alignment diagnostics do not identify a corrective lag, timestamp basis, or
  sampling-policy fix that raises cross-source agreement above the reviewed threshold.
- The residual cross-source disagreement is reported as provider/rendering variance in
  INFRA, DATA, and REL evidence.

Size and order-count parity are diagnostic only until separately normalized and reviewed.
They must not be used as hard V1 pass/fail criteria for MBP10 market-state parity.

Replay byte-identity is provider-internal. REL replay gates must compare Rithmic-derived
runtime output against Rithmic-derived replay output, or Databento-derived historical output
against Databento-derived replay output. V1 must not claim byte-identical replay between
Rithmic and Databento.

REL gates must report cross-source disagreement as telemetry. They must not hide, round
away, or relabel the cross-source delta as exact parity.

## Consequences

The MBP10 price-state sub-scope of `DATA-01B` may proceed after the revised INFRA-01
summary report records:

- `data01b_mbp10_price_state_eligible = true`;
- `classification = "provider_rendering_variance"`;
- `route_to = "DATA-01B_MBP10_PRICE_STATE_SUBSCOPE"`.

Full `DATA-01B` remains partially blocked until MBO parity is separately completed and
accepted. MBO-derived features, queue-position features, order-level features, and any
feature gate requiring MBO evidence remain blocked.

Full `DATA-01` remains blocked until all required DATA-01B sub-scopes and the revised
INFRA-01 verification report explicitly route to `DATA-01`.

This decision does not add live execution, order routing, or any Rithmic `ORDER_PLANT`
dependency.
