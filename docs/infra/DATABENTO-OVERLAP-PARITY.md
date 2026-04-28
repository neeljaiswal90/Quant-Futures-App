# Databento Overlap Parity

Databento overlap parity is the evidence review that compares a Rithmic probe against
Databento historical data for the same MNQ contract and exchange-time window.

This review does not unblock `DATA-01` by itself. `DATA-01` remains blocked until the
final INFRA-01 verification report explicitly says `data01_eligible = true` and
`route_to = DATA-01`.

Current partial status:

- Rithmic rich probe capture works.
- Databento `trades` and `mbp-1` files cover the Rithmic window.
- L1/trade partial parity can proceed.
- MBP10 price-state parity is accepted for V1 under
  [ADR-0002](../adr/ADR-0002-cross-source-market-data-parity.md) after DATA-PARITY-08
  triangulation.
- Databento `mbo` parity, full L2/L3 feature parity, MBP10 size/order-count hard-gate
  parity, and MBO event/action parity are not validated.

DATA-01 remains blocked as a full gate. If the work is split, `DATA-01A` may cover
L1/trade canonical ingestion and partial parity status `L1_TRADE_ONLY_PASS`; `DATA-01B`
may proceed only for the MBP10 price-state sub-scope accepted by ADR-0002. Do not enable
MBO feature gates, mark MBO/queue-derived features as verified, start SIM-02/SIM-03,
generate ML datasets, or advance REL gates from MBP10 price-state evidence alone.

## Required Rithmic Probe

Use a rich parity probe:

```powershell
python scripts/infra/capture-rithmic-probe.py --duration-sec 2100 --streams LAST_TRADE,L1_QUOTE,MBP10,MBO --symbol MNQM6 --exchange CME --parity-payload --out data/probes/infra01/full/probe-parity.jsonl
```

The older timestamp-only probe shape can validate timestamp coverage and ordering, but it
cannot support true parity because it does not include trade prices, BBO fields, top-10
book levels, or MBO order updates.

## Stream Mapping

| Rithmic stream | Databento schema | Parity basis |
| --- | --- | --- |
| `LAST_TRADE` | `trades` | trade price, size, side/aggressor when available |
| `L1_QUOTE` | `mbp-1` | best bid/ask price, size, and order count when available |
| `MBP10` | `mbp-10` | top-10 bid/ask price levels, size, and order count |
| `MBO` | `mbo` | order action, side, price, size, order ID, priority, sequence |

`exchange_event_ts_ns` remains the Rithmic canonical event-time field. Databento `ts_event`
is the comparison timestamp. `sidecar_recv_ts_ns` and Databento `ts_recv` are receive-time
telemetry, not canonical replay time.

## MBP10 Reconstruction

Do not treat each Rithmic `MBP10` row as a complete top-10 book snapshot.

Before using this Databento comparison as evidence, the Rithmic `MBP10` extractor must
pass the internal Rithmic L1/MBP10 audit from DATA-PARITY-04. If that audit reports
`mbp10_extraction_trusted = false`, run the DATA-PARITY-04B raw proto debug capture and
fix or manually review the extractor before comparing against Databento. A failed internal
Rithmic L1/MBP10 audit means Databento mismatch counts are not yet meaningful market-data
parity evidence.

The rich Rithmic probe can emit `MBP10` rows that contain only one bid price, only one ask
price, or another partial price-level update. The parity review must maintain a
reconstructed top-10 state:

1. Start with an empty bid/ask book.
2. Apply usable null-`exchange_event_ts_ns` rows as optional seed state only after the
   extractor has sorted snapshot arrays into derived top-10 levels.
3. Count every null-timestamp row, and exclude those rows from timestamp parity metrics.
4. Apply each timestamped `MBP10` row as an incremental update to the existing side/price
   state in `exchange_event_ts_ns` order. Rithmic raw array index is not a stable depth
   level, and capture/file order is not the comparison clock.
5. Emit reconstructed samples after timestamped updates for comparison with Databento
   `mbp-10` samples by sorting bids high-to-low and asks low-to-high, then deriving depth
   levels `0..9`.

Rithmic `OrderBook` rows now carry `book_update_kind` and `source_index` diagnostics in
rich probe mode. Use `px` as the state key for Rithmic reconstruction; use derived
`level` values only for the final comparable top-10 sample.

This rule is implemented by:

```powershell
npm run infra:analyze-databento-parity -- `
  --rithmic-probe data/probes/infra01/full/probe-parity.jsonl `
  --databento-mbp10 data/probes/infra01/full/databento/MNQM6_mbp10.normalized.jsonl `
  --databento-mbp1 data/probes/infra01/full/databento/MNQM6_mbp1.normalized.jsonl `
  --out reports/infra/databento_overlap_parity_report.json
```

The Databento input is an offline normalized JSONL export, not a live fetch. Each row must
carry a decimal-nanosecond `ts_event_ns` and either `bids[]`/`asks[]` arrays or flat fields
such as `bid_px_00`, `bid_sz_00`, `bid_ct_00`, `ask_px_00`, `ask_sz_00`, and `ask_ct_00`.
The analyzer compares each Databento sample against the latest reconstructed Rithmic book
state at or before that Databento `ts_event_ns`.

For internal Rithmic extraction trust, DATA-PARITY-04 compares reconstructed MBP10 state at
Rithmic `L1_QUOTE` checkpoints after exchange-time ordering. Do not use per-row MBP10
updates as top-of-book checkpoints; `solo` updates are partial price-level changes.

The report includes:

- seed row count,
- incremental update row count,
- reconstructed book sample count,
- top-of-book parity,
- depth-level parity where both sides provide comparable fields,
- mismatches grouped by side and level.

## MBP10 Component Scoring

DATA-PARITY-06 splits the MBP10 comparison into component scores so reviewers can tell
whether a failed aggregate comparison is a market-state disagreement or a vendor field
semantics mismatch.

The analyzer still emits the coarse `mbp10_parity` section for continuity, but the
reviewer-facing section is `mbp10_component_parity`:

- `top_of_book` reports bid/ask price parity within one MNQ tick, exact size parity, exact
  order-count parity, and top-level size delta distributions.
- `depth_by_level` reports each bid/ask level `0..9` independently with price, size,
  order-count, and level-presence scores.
- `mismatch_breakdown` separates price-only, size-only, order-count-only, price+size, mixed,
  and missing-level mismatches.
- `first_mismatches` records deterministic examples for price, size, order-count, and
  level-presence mismatches.

Price, size, and order count are intentionally separate:

- Price mismatches suggest reconstruction, sampling alignment, or vendor book-state
  disagreement.
- Size mismatches can reflect different aggregation, implied-order, or update-timing
  semantics even when the price ladder is aligned.
- Order-count mismatches are especially vendor-sensitive and should not fail market-state
  parity unless the reviewer has confirmed both feeds expose compatible count semantics.
- Level-presence mismatches mean one source has a comparable depth level while the other
  does not; first check sampling alignment and update application rules.

Classification values:

- `mbp10_parity_component_pass`: price, size, order-count, and presence components are all
  high.
- `size_order_count_semantics_mismatch`: price parity is high, but size or order-count
  parity is low; review vendor semantics before failing market-state parity.
- `price_level_reconstruction_mismatch`: price parity is low; revisit Rithmic/Databento
  reconstruction before interpreting size/order-count.
- `book_depth_presence_mismatch`: level presence parity is low; compare sampling windows,
  depth availability, and update application rules.
- `inconclusive_component_mismatch`: mixed evidence that needs manual review.

`mbp10_component_parity` remains evidence only. The report status stays
`analysis_only`, `data01_eligible` stays `false`, and `DATA-01B` stays blocked until a
reviewer accepts the component interpretation and the revised INFRA-01 verification report
explicitly routes to `DATA-01`.

## MBP10 Temporal Alignment Diagnostics

DATA-PARITY-07 adds temporal diagnostics for the case where component price parity is below
the reviewer threshold. This is the next step after the component report says
`price_level_reconstruction_mismatch`: first prove whether the mismatch is caused by
timestamp alignment or sampling policy before revisiting extractor logic.

The `mbp10_temporal_alignment` section compares Databento `mbp-10` samples against compact
Rithmic reconstructed MBP10 top-10 checkpoints under multiple policies:

- `previous_or_equal`: compare against the latest Rithmic state at or before the Databento
  timestamp.
- `nearest`: compare against the closest Rithmic state by `exchange_event_ts_ns`.
- `next_or_equal`: compare against the next Rithmic state at or after the Databento
  timestamp.
- `midpoint_bucketed`: choose the previous or next Rithmic state by midpoint distance
  between adjacent checkpoints.

The lag scan applies fixed offsets to the Databento comparison timestamp before selecting
the Rithmic state:

```text
-500, -250, -100, -50, -25, -10, -5, 0, +5, +10, +25, +50, +100, +250, +500 ms
```

Positive offsets mean "compare the Databento sample to a later Rithmic state." If a nonzero
offset lifts both-side top price parity above 99%, the report classifies the issue as
`temporal_alignment_offset_required` and the offset sign must be reviewed before changing
INFRA-01 policy.

Timestamp-basis scoring compares Databento `ts_event` with `ts_recv` when the normalized
Databento JSONL includes receive timestamps. If the normalized rows only include
`ts_event_ns`, `ts_recv_available` is `false` and `best_timestamp_basis` remains `ts_event`.

Mismatch clustering reports price-mismatch runs under the baseline
`previous_or_equal`/`ts_event`/`0 ms` policy:

- total price-mismatch and price-match sample counts,
- max consecutive mismatch run,
- first mismatch clusters,
- per-minute mismatch rates.

Trade-burst correlation and Databento MBP-1 BBO cross-checks are reported as
`not_available` unless the analyzer is extended with normalized trade and MBP-1 inputs.
The always-available cross-check is Rithmic reconstructed MBP10 top-of-book vs Databento
`mbp-10` top-of-book.

Temporal classifications:

- `temporal_alignment_offset_required`: a nonzero lag scan offset lifts both-side top price
  parity above threshold.
- `sampling_policy_mismatch`: nearest or next-state sampling materially improves price
  parity above threshold.
- `timestamp_basis_mismatch`: Databento receive-time scoring materially improves parity
  above threshold.
- `persistent_price_level_reconstruction_mismatch`: none of the tested lookup, lag, or
  timestamp-basis policies resolves the price mismatch.

DATA-01B remains blocked for every temporal classification until a reviewer accepts the
evidence and the revised INFRA-01 verification report explicitly routes to `DATA-01`.

The analyzer is evidence tooling only. Its output uses `status: "analysis_only"` and keeps
`data01_eligible: false`; a reviewer must still decide the final INFRA-01 policy and produce
the revised INFRA-01 verification report before `DATA-01` can move.

## BBO Cross-Source Triangulation

DATA-PARITY-08 adds a `bbo_triangulation` section for the case where temporal diagnostics
prove that MBP10 disagreement is not explained by lag, timestamp basis, or lookup policy.
The goal is to identify which surface disagrees before changing any gate:

- Rithmic reconstructed `L1_QUOTE` BBO vs Databento `mbp-1`.
- Rithmic reconstructed `MBP10` top-of-book vs Rithmic reconstructed `L1_QUOTE`.
- Databento `mbp-10` top-of-book vs Databento `mbp-1`.
- Rithmic reconstructed `MBP10` top-of-book vs Databento `mbp-10`.

The Databento `mbp-1` input is optional for backward compatibility, but without it the two
MBP-1 triangulation legs are reported as `not_available` and the decision tree is weaker.
Use normalized JSONL with `ts_event_ns` and top-level fields such as `bid_px_00`,
`bid_sz_00`, `bid_ct_00`, `ask_px_00`, `ask_sz_00`, and `ask_ct_00`.

For large canonical probes, prefer the dedicated BBO triangulation CLI so the component and
temporal MBP10 analyzer does not have to repeat all prior scoring work:

```powershell
npm run infra:analyze-bbo-triangulation -- `
  --rithmic-probe data/probes/infra01/full/probe-parity.jsonl `
  --databento-mbp10 data/probes/infra01/full/databento/MNQM6_mbp10.normalized.jsonl `
  --databento-mbp1 data/probes/infra01/full/databento/MNQM6_mbp1.normalized.jsonl `
  --out reports/infra/databento_bbo_triangulation_report.json
```

Each available comparison reports:

- `compared_samples` and `unmatched_samples`,
- bid, ask, and both-side top price within one MNQ tick,
- bid/ask size exact-match percentages,
- lookup-policy scores for `previous_or_equal`, `nearest`, `next_or_equal`, and
  `midpoint_bucketed`,
- first 20 deterministic mismatch examples,
- mismatch rate by one-minute exchange-time bucket.

Triangulation classifications:

- `rithmic_mbp10_extraction_issue`: Rithmic MBP10 top-of-book disagrees with reconstructed
  Rithmic L1. Revisit the Rithmic extractor/reconstructor before cross-vendor parity.
- `databento_mbp10_normalization_issue`: Databento MBP-10 top-of-book disagrees with
  Databento MBP-1. Inspect the Databento normalizer or schema semantics before judging
  Rithmic.
- `l1_cross_source_alignment_issue`: Rithmic L1 and Databento MBP-1 disagree. Resolve BBO
  cross-source alignment before interpreting MBP10 depth.
- `mbp10_depth_semantics_issue`: L1 and same-vendor internal checks are strong, but
  cross-vendor MBP10 still disagrees. Review depth aggregation, implied-liquidity, and
  vendor feed semantics.
- `inconclusive`: available checks do not isolate a single source of disagreement.

`bbo_triangulation` is still evidence only. It keeps `status: "analysis_only"` and
`data01b_eligible: false`; DATA-01B remains blocked until a reviewer accepts the
triangulation result and the revised INFRA-01 verification report explicitly routes to
`DATA-01`.

## INFRA-01E Accepted MBP10 Price-State Policy

INFRA-01E accepts the DATA-PARITY-08 triangulation result as the V1 MBP10 price-state
decision:

| Comparison | Agreement | Policy reading |
| --- | ---: | --- |
| Rithmic `MBP10` vs Rithmic `L1_QUOTE` | 99.647858% | Rithmic internal extraction is trusted |
| Databento `mbp-10` vs Databento `mbp-1` | 99.965621% | Databento internal extraction is trusted |
| Rithmic `L1_QUOTE` vs Databento `mbp-1` | 96.92945% | Cross-source provider/rendering variance |
| Rithmic `MBP10` vs Databento `mbp-10` | 95.993782% | Same cross-source ceiling propagates to MBP10 |

Accepted for V1:

- MBP10 price-state parity under documented cross-source tolerance.
- Exchange-event-time alignment.
- Provider-internal replay parity.

Diagnostic only:

- MBP10 size parity.
- MBP10 order-count parity.
- Cross-source Rithmic-vs-Databento byte identity.

Still blocked:

- MBO parity.
- MBO-derived and queue-position features.
- Full DATA-01B and full DATA-01 routing.
- SIM-02/SIM-03, ML/research dataset generation, and REL gates that depend on full
  L2/L3/MBO evidence.

The revised summary report generated by `npm run infra:01e:decision` records
`data01b_mbp10_price_state_eligible = true`, `data01_full_eligible = false`, and
`route_to = DATA-01B_MBP10_PRICE_STATE_SUBSCOPE`.

## MBO Event/Action Parity Diagnostic

DATA-PARITY-10 adds a separate MBO diagnostic because MBO is event/action/order-level data,
not price-level book state. Use:

```powershell
npm run infra:analyze-mbo-parity -- `
  --rithmic-probe data/probes/infra01/full/probe-parity-post04d.jsonl `
  --databento-mbo data/probes/infra01/full/databento/MNQM6_mbo_post04d.normalized.jsonl `
  --out reports/infra/mbo_parity_report_post04d.json
```

The report compares action, side, price, size, sequence, order-id coverage, and coarse
one-second event signatures. Order ID equality is diagnostic only unless both feeds are
proven to expose compatible exchange-native order IDs and lifecycle semantics.

MBO parity remains `analysis_only` until a reviewer accepts a policy decision. Full
`DATA-01B`, MBO-derived features, queue-position features, SIM-02/SIM-03, ML/research, and
REL gates remain blocked from MBO evidence until that decision exists.

## Report Status

The INFRA-01B evaluator consumes a compact parity report through:

```powershell
npm run infra:01:evaluate -- --probe data/probes/infra01/full/probe-parity.jsonl --clock data/probes/infra01/full/clock_sync.json --databento-parity reports/infra/databento_overlap_parity_report.json --out reports/infra/infra01b_with_databento_parity_report.json
```

Use `status: "pending"` until a reviewer has compared all four stream mappings. Do not set
`status: "pass"` from availability/window checks alone.

```json
{
  "databento_overlap_parity": {
    "present": true,
    "status": "pending",
    "summary": "Databento overlap review is not finalized.",
    "matched_windows": 0,
    "unmatched_event_count": 0,
    "max_price_alignment_ticks": 0,
    "notes": "Requires reviewed trade, BBO, MBP10, and MBO parity."
  }
}
```

## Non-Goals

- Do not commit raw Rithmic or Databento captures.
- Do not change `DATA-01` status from parity tooling alone.
- Do not loosen INFRA-01B stream monotonicity policy without an explicit policy ticket and
  reviewed parity evidence.
- Do not use `ORDER_PLANT`, live execution, sockets, Bookmap, TradingView, or legacy paths.
