# DATA-05A: L1/Trade Journal Retention And Rotation

DATA-05A applies the V1 retention policy to the DATA-01A verified surface only:

- `L1_QUOTE`
- `LAST_TRADE`

It does not enable MBP10 or MBO ingestion. Full DATA-01 remains blocked until DATA-01B
proves MBP10/MBO Databento parity.

## Policy

The DATA-05A defaults mirror the raw-journal slice of the plan §13.2 retention policy:

| Artifact | DATA-05A behavior |
|---|---|
| Raw uncompressed L1/trade JSONL | Keep current RTH session + one prior RTH session |
| Raw compressed L1/trade JSONL | Keep hot for 14 calendar days |
| Disk pressure | Warn at 70% used, fail-closed at 85% used |

The policy is intentionally scoped to L1/trade journals. Mixed journals or journals
containing event types outside `QUOTE`/`TRADE` are skipped with diagnostics.

## Deterministic Reference

Retention never reads wall-clock time. Callers must provide:

```text
--reference-session-id YYYY-MM-DD-rth
```

That reference session determines which raw sessions are retained and which compressed
archives are older than the hot retention window.

Disk pressure is also deterministic. The retention tool does not read host disk state on
its own; callers pass a disk snapshot when they want pressure classification:

```text
--disk-total-bytes <bytes>
--disk-free-bytes <bytes>
```

At or above 70% used, the report status becomes `warning`. At or above 85% used, the report
status becomes `fail` and `disk_pressure.data_writes_allowed = false`.

## Command

Plan-only mode is the default:

```powershell
npm run data:05a:retention -- `
  --journal-dir data/probes/infra01/data01a `
  --archive-dir data/probes/infra01/data01a/archive `
  --reference-session-id 2026-04-26-rth `
  --disk-total-bytes 1000000000000 `
  --disk-free-bytes 250000000000 `
  --report reports/infra/data05a_retention_report.json
```

Apply mode performs deterministic gzip compression for raw sessions outside the raw
retention window and deletes compressed archives outside the hot retention window:

```powershell
npm run data:05a:retention -- `
  --journal-dir data/probes/infra01/data01a `
  --archive-dir data/probes/infra01/data01a/archive `
  --reference-session-id 2026-04-26-rth `
  --report reports/infra/data05a_retention_report.json `
  --apply
```

## Report Fields

The report includes:

- `mode`: `plan` or `apply`.
- `reference_session_id`.
- `retained_raw_sessions`.
- `keep_raw_count`.
- `compress_raw_count`.
- `delete_compressed_count`.
- `actions`.
- `diagnostics`.
- `disk_pressure`, including `used_pct`, `severity`, and `data_writes_allowed`.
- `policy`.
- `partial_parity_status: L1_TRADE_ONLY_PASS`.
- `data01_full_gate_status: blocked`.
- `data01b_status: blocked_l2_l3_parity`.

## DATA-01 Guardrail

DATA-05A improves operational hygiene for the verified L1/trade stream, but it does not
advance DATA-01, SIM, ML, RSRCH, or REL gates. L2/L3 work remains blocked until:

- Databento `mbp-10` is available.
- Databento `mbo` is available.
- MBP10 reconstructed-state parity passes.
- MBO event/action parity passes.
- The revised INFRA-01 verification report routes to DATA-01.
