# DATA-07A: L1/Trade-Only Gap Detection

DATA-07A adds deterministic gap detection for the DATA-01A verified surface:

- `L1_QUOTE`
- `LAST_TRADE`

It does not enable MBP10 or MBO ingestion. Full DATA-01 remains blocked until DATA-01B
proves MBP10/MBO Databento parity.

## Scope

DATA-07A reads the same rich Rithmic probe/provider JSONL accepted by DATA-01A and reuses
the DATA-01A normalizer. Only rows that can become OBS-01 `QUOTE` or `TRADE` source events
enter gap detection. Rows from `MBP10` and `MBO` are counted as blocked diagnostics.

`exchange_event_ts_ns` is the only canonical clock. `sidecar_recv_ts_ns` is preserved in
gap diagnostics as telemetry, but it is never used to decide whether a gap occurred.

## Default Thresholds

| Stream | Warning | Fail | Semantics |
|---|---:|---:|---|
| `L1_QUOTE` | 1000 ms | 5000 ms | Quote gaps are strong evidence of feed staleness. |
| `LAST_TRADE` | 60000 ms | 300000 ms | Trade silence can be natural, so thresholds are conservative. |

Quote gaps and trade silence use different reason codes:

- `l1_quote_feed_gap_warning`
- `l1_quote_feed_gap_fail`
- `last_trade_silence_warning`
- `last_trade_silence_fail`
- `l1_quote_exchange_timestamp_decrease`
- `last_trade_exchange_timestamp_decrease`

## Command

```powershell
npm run data:07a:gap-report -- `
  --input data/probes/infra01/full/probe-parity.jsonl `
  --report reports/infra/data07a_l1_trade_gap_report.json
```

Optional threshold overrides:

```powershell
npm run data:07a:gap-report -- `
  --input data/probes/infra01/full/probe-parity.jsonl `
  --report reports/infra/data07a_l1_trade_gap_report.json `
  --quote-warning-ms 1000 `
  --quote-fail-ms 5000 `
  --trade-warning-ms 60000 `
  --trade-fail-ms 300000
```

## Report Fields

The report includes:

- `status`: `pass`, `warning`, or `fail`.
- `streams_checked`: always `L1_QUOTE` and `LAST_TRADE`.
- `quote_gap_count` and `trade_gap_count`.
- `max_quote_gap_ms` and `max_trade_gap_ms`.
- `warning_count` and `fail_count`.
- `stream_summaries` with per-stream record counts and max gaps.
- `gaps` with bounded journal-ready diagnostics.
- `diagnostic_counts` for skipped or malformed rows.
- `partial_parity_status: L1_TRADE_ONLY_PASS`.
- `data01_full_gate_status: blocked`.
- `data01b_status: blocked_l2_l3_parity`.

## DATA-01 Guardrail

DATA-07A can improve L1/trade reliability evidence for future REL work, but it does not
advance DATA-01, SIM, ML, RSRCH, or REL gates. L2/L3 work remains blocked until:

- Databento `mbp-10` is available.
- Databento `mbo` is available.
- MBP10 reconstructed-state parity passes.
- MBO event/action parity passes.
- The revised INFRA-01 verification report routes to DATA-01.
