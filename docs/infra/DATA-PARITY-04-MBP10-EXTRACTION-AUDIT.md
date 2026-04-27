# DATA-PARITY-04 - Rithmic MBP10 Extraction Audit

## Purpose

DATA-PARITY-04 validates the Rithmic `MBP10` extraction before Databento `mbp-10`
parity is trusted.

The trigger for this ticket was a failed Databento overlap parity run where reconstructed
Rithmic `MBP10` produced very large top-of-book and depth mismatches. The first Rithmic
`MBP10` seed row also contained implausible MNQ prices such as `2460.0`, `2477.25`,
`2482.0`, `2750.0`, `10000.5`, and `12000.0`.

That evidence should not be treated as proven market disagreement. It is first an
extraction, scaling, or field-semantics question.

## Command

```powershell
npm run infra:audit-rithmic-mbp10 -- `
  --probe data/probes/infra01/full/probe-parity.jsonl `
  --out reports/infra/rithmic_mbp10_extraction_audit.json
```

The command is offline-only. It reads an existing rich Rithmic probe and writes a JSON
report. It does not fetch Databento data, connect to Rithmic, open sockets, or modify any
gate status.

## DATA-PARITY-04B Raw Proto Debug Capture

If the audit reports `classification = extraction_bug_suspected`, capture a small raw
OrderBook debug sample:

```powershell
python scripts/infra/capture-rithmic-probe.py `
  --duration-sec 60 `
  --streams LAST_TRADE,L1_QUOTE,MBP10 `
  --symbol MNQM6 `
  --exchange CME `
  --parity-payload `
  --debug-mbp10-raw `
  --debug-mbp10-limit 50 `
  --debug-mbp10-out reports/infra/mbp10_raw_debug.jsonl `
  --out data/probes/infra01/smoke/probe-mbp10-debug.jsonl
```

The debug JSONL is an artifact and must not be committed. It contains:

- one `mbp10_descriptor` row with the OrderBook proto descriptor field names, field
  numbers, protobuf types, repeated flags, and nested fields where available;
- up to `--debug-mbp10-limit` `mbp10_raw_message` rows;
- raw proto bytes as `raw_b64`;
- raw proto field names and values;
- current normalized MBP10 extraction output;
- nearest prior `L1_QUOTE` bid/ask/mid when available;
- candidate price scales: raw, `/10`, `/100`, `/1000`, `/10000`, and `/1e9`;
- explicit `data01b_eligible = false` and `data01_status = blocked`.

Analyze the dump with:

```powershell
npm run infra:analyze-mbp10-debug -- `
  --debug-dump reports/infra/mbp10_raw_debug.jsonl `
  --out reports/infra/mbp10_debug_dump_analysis.json
```

Use this report to decide whether the extractor needs a scale fix, a side/level semantic
fix, or direct manual proto review. The debug analyzer does not automatically alter
normalization behavior.

## DATA-PARITY-04C Price-Level Semantics

The DATA-PARITY-04B debug dump showed that Rithmic `OrderBook` prices are already in
the correct scale for MNQ. The failure was field semantics:

- `update_type = snapshot_image` rows can contain large bid/ask price arrays rather than
  pre-trimmed top-10 levels.
- Bid snapshot arrays can arrive low-to-high, so the best bid is near the end of the raw
  array, not necessarily at index `0`.
- Ask snapshot arrays must be sorted before deriving depth levels.
- `update_type = solo` rows are price-level updates, often one bid or one ask price, not
  complete depth snapshots and not "replace depth level 0" records.

The collector therefore normalizes Rithmic `MBP10` as follows:

- Snapshot-like `OrderBook` rows are filtered to positive price/size, sorted by price
  (`bid` high-to-low, `ask` low-to-high), and only then assigned derived `level` values
  `0..9`.
- Incremental `solo` rows are emitted as `book_update_kind = price_level_update` with
  `source_index` preserved. Downstream reconstruction keys them by `px`, not by raw array
  index.
- Zero-size price-level updates delete that price from the reconstructed side.
- `level` on Rithmic rows is an output convenience only. It must not be treated as a
  stable Rithmic state key.

After this change, a fresh rich probe is required. Older probe files captured before
DATA-PARITY-04C can still contain truncated or unsorted seed rows and should not be used
to declare extraction trusted.

## DATA-PARITY-04D Audit Checkpoints

DATA-PARITY-04C fixed the Rithmic extraction model, but the first post-fix audit still
reported a false failure because it compared every individual `MBP10` update as though
each row were a complete top-of-book checkpoint.

The audit now applies timestamped Rithmic `MBP10` price-level updates in
`exchange_event_ts_ns` order and compares the latest reconstructed book state only at
Rithmic `L1_QUOTE` timestamps. This matches the internal-consistency question the audit is
meant to answer:

```text
At each L1 quote checkpoint, does reconstructed MBP10 top-of-book match L1 bid/ask?
```

Do not score internal extraction trust by treating every `solo` MBP10 price-level update
as a standalone quote. A bid-only or ask-only book update can be correct even when the
opposite side was not updated in the same row.

The post-04D confirmation command is:

```powershell
npm run infra:audit-rithmic-mbp10 -- `
  --probe data/probes/infra01/smoke/probe-mbp10-04c-smoke.jsonl `
  --out reports/infra/rithmic_mbp10_extraction_audit_after_04d.json
```

Expected trusted-extraction evidence:

```text
mbp10_extraction_trusted = true
classification = state_stream_incremental_valid
internal_l1_mbp10_parity.comparison_rule =
  exchange_ordered_mbp10_state_at_rithmic_l1_quote_checkpoints
internal_l1_mbp10_parity.within_1_tick_pct >= 99
```

## DATA-PARITY-04E Full-Probe Reconstructed L1 Checkpoints

DATA-01A-FU showed that Rithmic `L1_QUOTE` is also side-specific state updates. The rich
diagnostic audit remains useful for smoke/debug probes, but the canonical 35-minute probe
can contain millions of reconstructed L1 checkpoints and millions of MBP10 updates. Use the
disk-backed checkpoint audit for full-probe trust evidence:

```powershell
npm run infra:audit-mbp10-l1-checkpoints -- `
  --probe data/probes/infra01/full/probe-parity-post04d.jsonl `
  --out reports/infra/mbp10_l1_checkpoint_audit_post04d_full.json
```

This command stores sortable checkpoint/update rows in a local sqlite work DB, applies
MBP10 updates in exchange-time order, reconstructs L1 BBO checkpoints from bid-only and
ask-only `L1_QUOTE` rows, and compares MBP10 top-of-book at every reconstructed L1
checkpoint. The sqlite work DB is deleted after the run unless `--keep-work-db` is set.

Post DATA-01A-FU full-probe evidence:

```text
mbp10_extraction_trusted = true
classification = state_stream_incremental_valid
l1_quote_reconstructed_checkpoint_count = 1,929,904
compared_checkpoint_count = 1,929,904
within_1_tick_pct = 99.823748
```

This supersedes the earlier sparse-checkpoint MBP10 trust result. It confirms MBP10
extraction remains trusted when scored against reconstructed L1 BBO checkpoints at fine
granularity. It still does not unblock DATA-01B without Databento MBP10 and MBO parity.

## Core Invariant

Before comparing Rithmic `MBP10` to Databento `mbp-10`, reconstructed Rithmic `MBP10`
top-of-book should agree with Rithmic `L1_QUOTE` top-of-book over overlapping
exchange-time windows. The comparison is performed at Rithmic `L1_QUOTE` checkpoints
after applying Rithmic `MBP10` updates in exchange-time order.

The audit requires the internal L1/MBP10 comparison to reach at least:

```text
mbp10_extraction_trusted = true
internal_l1_mbp10_parity.within_1_tick_pct >= 99
classification = state_stream_incremental_valid
```

If this internal check fails, Databento parity is not meaningful yet.

After any extraction change, rerun:

```powershell
npm run infra:audit-rithmic-mbp10 -- `
  --probe data/probes/infra01/full/probe-parity.jsonl `
  --out reports/infra/rithmic_mbp10_extraction_audit.json
```

Only proceed to Databento `mbp-10` parity when the audit reaches at least 99% internal
Rithmic L1/MBP10 agreement within one MNQ tick and reports
`classification = state_stream_incremental_valid`.

## Null Timestamp Seed Policy

Null `exchange_event_ts_ns` `MBP10` rows are not trusted as market-state seeds by default.
The audit counts them separately and reports whether they contain implausible prices.

The CLI option exists for experiments:

```powershell
--allow-null-seed true
```

Default behavior remains:

```text
--allow-null-seed false
```

## Analysis Performed

The report includes:

- `probe_parsing`: L1 and MBP10 row counts, timestamped/null row counts, one-sided update counts.
- `null_seed_analysis`: null timestamp seed rows and implausible seed examples.
- `price_sanity`: MNQ tick alignment and distance from nearby Rithmic L1 mid.
- `internal_l1_mbp10_parity`: reconstructed MBP10 best bid/ask vs Rithmic L1 bid/ask.
- `reconstruction_modes`: comparison across reconstruction policies.
- `field_scaling_diagnostics`: field names, level counts, value distributions, and scale-factor evidence.
- `classification`: the audit conclusion.
- `recommendation`: the next action.

## Reconstruction Modes

The audit compares:

- `no_null_seed_rows`
- `null_seed_rows_allowed`
- `reset_book_on_implausible_seed`
- `timestamped_rows_only`
- `plausible_l1_range_only`

The best mode is selected by highest internal L1/MBP10 within-one-tick rate, then by the
number of compared samples.

## Classification Meanings

`state_stream_incremental_valid`

Rithmic MBP10 reconstruction is internally consistent with Rithmic L1. Databento MBP10
parity may proceed, but DATA-01B still requires reviewer approval and MBO parity.

`null_seed_contamination`

Null timestamp seed rows appear to poison the reconstructed book. Disable null seed use
before rerunning Databento MBP10 parity.

`price_scaling_error_suspected`

A non-1 scale factor appears materially more plausible than raw prices. Do not change
scaling automatically; inspect Rithmic proto fields and update extraction only after
manual review.

`field_semantics_mismatch`

The extracted fields are shaped like book levels but do not behave like current top-of-book
state. Inspect raw Rithmic proto fields and message semantics.

`extraction_bug_suspected`

Implausible prices are present and internal L1/MBP10 parity fails. A direct proto debug
dump is required before trusting MBP10 parity.

`inconclusive`

The probe does not contain enough comparable evidence to decide.

## DATA-01B Guardrail

DATA-01B remains blocked regardless of this tool's output. Full DATA-01 closure still
requires:

- trusted Rithmic MBP10 extraction,
- reviewed Databento MBP10 parity,
- reviewed Databento/Rithmic MBO parity,
- revised INFRA-01 verification explicitly routing to `DATA-01`.

Do not use this audit to enable MBP10/MBO feature gates, SIM-02/SIM-03, ML/RSRCH datasets,
REL-00, or REL-01.
