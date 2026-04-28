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
- Databento `mbp-10` parity, Databento `mbo` parity, L2/L3 feature parity, MBP10
  reconstructed book parity, and MBO event/action parity are not validated.

DATA-01 remains blocked as a full gate. If the work is split, `DATA-01A` may only cover
L1/trade canonical ingestion and partial parity status `L1_TRADE_ONLY_PASS`; `DATA-01B`
must remain blocked for L2/L3 parity. Do not enable MBP10/MBO feature gates, mark
OFI/depth/MBO-derived features as verified, start SIM-02/SIM-03, generate ML datasets, or
advance REL gates from L1/trade-only evidence.

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

The analyzer is evidence tooling only. Its output uses `status: "analysis_only"` and keeps
`data01_eligible: false`; a reviewer must still decide the final INFRA-01 policy and produce
the revised INFRA-01 verification report before `DATA-01` can move.

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
