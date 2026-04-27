# INFRA-01C: Rithmic Quote/Book Timestamp Order Analysis

## Purpose

INFRA-01C is an offline evidence tool for the INFRA-01B Rithmic probe failure mode where
`exchange_event_ts_ns` decreases inside quote or book streams.

It does not change the INFRA-01B pass/fail gate and it does not unblock `DATA-01`.
`DATA-01` remains blocked until the final INFRA-01 verification report explicitly says
`data01_eligible = true` and `route_to = DATA-01`.

## Why This Exists

A completed 35-minute Rithmic probe captured all four V1 streams with high timestamp coverage:

- `L1_QUOTE`
- `LAST_TRADE`
- `MBP10`
- `MBO`

INFRA-01B still failed because `L1_QUOTE` and `MBP10` had stream-local
`exchange_event_ts_ns` decreases while `LAST_TRADE` and `MBO` remained monotonic.
INFRA-01C determines whether that pattern looks like:

- an extraction bug,
- a timestamp semantics mismatch,
- bounded out-of-order delivery,
- a state stream that is not a strict event stream,
- or inconclusive evidence.

The original probe was timestamp-only. It is useful for INFRA-01C timestamp-order analysis,
but it cannot prove Databento trade/BBO/book parity because it does not retain price,
size, top-of-book, top-10 depth, or MBO order-update payload fields. Future probes intended
for Databento overlap parity must be captured with `--parity-payload`.

## Command

```powershell
npm run infra:analyze-timestamp-order -- `
  --probe data/probes/infra01/full/probe.jsonl `
  --out reports/infra/infra01c_timestamp_order_report.json
```

The command is offline-only. It reads committed or local probe JSONL and writes a
deterministic JSON report. It does not connect to Rithmic, Databento, sockets, or any
live execution surface.

## Report Contents

For each stream, the report includes:

- record count,
- timestamp coverage,
- non-decreasing pass/fail,
- violation count and violation rate,
- first and last violation,
- max negative delta in ns/ms,
- p50/p95/p99 negative-delta magnitude,
- counts by `timestamp_source`,
- counts by `template_id`,
- counts by `payload_kind`.

The sequence section reports whether sequence values are present, whether sequence is
monotonic, whether timestamp decreases occur while sequence remains monotonic, whether
violations are adjacent or clustered, and whether violations correlate with sequence gaps.

The cross-stream section compares:

- `LAST_TRADE` vs `MBO`,
- `L1_QUOTE` vs `MBP10`,
- `MBP10` violation timestamps against nearby `MBO` timestamps.

The disorder-window section tests whether local timestamp decreases would be bounded by:

- 1 ms,
- 5 ms,
- 10 ms,
- 50 ms,
- 100 ms,
- 500 ms.

This is a diagnostic bound, not a proposal to silently reorder transport facts.

## Classification Values

`extraction_bug_suspected`
: A strict event stream such as `LAST_TRADE` or `MBO` decreases, or the pattern otherwise
suggests the parser may be extracting the wrong timestamp field.

`timestamp_semantics_mismatch`
: Quote/book timestamps decrease in a way that suggests the chosen timestamp field may not
represent the ordering semantics expected by INFRA-01B.

`bounded_out_of_order_delivery`
: Decreases are confined to quote/book streams and all local decreases fit within a bounded
window.

`state_stream_not_strict_event_stream`
: Quote/book streams show repeated decreases at scale, which suggests state delivery rather
than strict event-stream ordering.

`inconclusive`
: The data does not contain enough disorder evidence to classify.

## Decision Needed Before INFRA-01B Changes

INFRA-01C can recommend options, but it must not change policy by itself. A reviewer still
needs to decide whether INFRA-01B should:

- remain strict monotonic for all streams,
- require strict monotonic only for `MBO` and `LAST_TRADE`,
- allow bounded disorder for `L1_QUOTE` and `MBP10`,
- order quote/book streams by Rithmic sequence while treating `exchange_event_ts_ns` as metadata,
- require Databento overlap parity before deciding.

Until that decision is made, the safe route remains:

```text
route_to = INFRA-01B
DATA-01 remains blocked
```

## Rich Parity Probe Dependency

`scripts/infra/capture-rithmic-probe.py --parity-payload` extends future probe JSONL with
normalized `LAST_TRADE`, `L1_QUOTE`, `MBP10`, and `MBO` payload fields while preserving the
same timestamp-evidence fields used by INFRA-01B and INFRA-01C. This does not loosen the
timestamp-order gate or mark Databento parity as passed. It only creates enough Rithmic
payload evidence for a later Databento parity report to compare:

- `LAST_TRADE` to Databento `trades`,
- `L1_QUOTE` to Databento `mbp-1`,
- `MBP10` to Databento `mbp-10`,
- `MBO` to Databento `mbo`.
