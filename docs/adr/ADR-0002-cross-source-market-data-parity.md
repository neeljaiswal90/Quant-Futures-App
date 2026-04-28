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

DATA-PARITY-10 and DATA-PARITY-11 then reviewed the post04D MBO evidence:

- Rithmic normalized `MBO` events: 2,842,114.
- Databento normalized `mbo` events: 3,159,591.
- Timestamp coverage, order ID coverage, price tick alignment, and sequence monotonicity
  were clean for both providers.
- Strict cross-source signature match was 89.951959% of Databento events.
- Structural book-action mode was approximately 95.17%.
- A material share of unmatched Databento events came from `trade` and `unknown`
  categories that Rithmic either publishes on `LAST_TRADE` or filters from MBO/control
  output.

The MBO evidence has the same shape as MBP10: both providers are internally clean, while
cross-source event taxonomy differs. The residual mismatch is therefore classified as MBO
provider/action-taxonomy variance, not corrupt or missing MBO data.

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

The MBO provider-internal sub-scope is accepted for V1 when:

- both provider extractors have full timestamp, order ID, tick-alignment, and non-decreasing
  sequence evidence;
- structural book-action parity remains above the reviewed 95% threshold;
- `trade` and `unknown` action categories are reported as cross-source taxonomy variance;
- downstream consumers operate within one provider at a time.

Eligible MBO work:

- order-ID lifecycle tracking within a single provider;
- queue-position estimation for SIM-03 calibration using a single-provider replay path;
- MBO-derived microstructure features whose inputs all come from the same provider.

Not eligible:

- Rithmic-vs-Databento order-by-order byte identity is not accepted;
- cross-feed order-ID replay parity;
- treating Databento `trade`/`unknown` MBO events as hard cross-feed failures without a
  separate mapping decision.

## Consequences

The MBP10 price-state sub-scope of `DATA-01B` may proceed after the revised INFRA-01
summary report records:

- `data01b_mbp10_price_state_eligible = true`;
- `classification = "provider_rendering_variance"`;
- `route_to = "DATA-01B_MBP10_PRICE_STATE_SUBSCOPE"`.

The MBO provider-internal sub-scope may proceed after the INFRA-01F summary report records:

- `data01b_mbo_subscope_eligible = true`;
- `classification = "mbo_action_taxonomy_provider_variance"`;
- `route_to = "DATA-01B_MBO_PROVIDER_INTERNAL_SUBSCOPE"`.

Full `DATA-01B` is not automatically passed by the policy decision. MBO consumers, the
authority FSM, the full microstructure feature engine, SIM calibration, and REL evidence
must still be implemented and verified.

Full `DATA-01` remains blocked until all required DATA-01B sub-scopes and the revised
INFRA-01 verification report explicitly route to `DATA-01`.

REL gates still require provider-internal replay evidence. They must not claim
Rithmic-vs-Databento order-by-order byte identity.

This decision does not add live execution, order routing, or any Rithmic `ORDER_PLANT`
dependency.
