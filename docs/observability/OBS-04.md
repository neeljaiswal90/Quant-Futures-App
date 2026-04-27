# OBS-04 - L1/Trade Latency Dashboard

## Status

OBS-04 is an offline-safe, read-only operator utility for inspecting L1/trade receive
latency from OBS-01 JSONL journals.

It consumes only the verified DATA-01A surface:

- `QUOTE`
- `TRADE`

`QUOTE` rows are OBS-01 BBO events emitted by DATA-01A after reconstructing Rithmic
side-specific L1 quote updates. OBS-04 should be run against the reconstructed DATA-01A
journal, not directly against raw Rithmic probe rows.

It does not consume or verify `MBP10` or `MBO` data. Full DATA-01 remains blocked until
Databento MBP-10 and MBO parity evidence is available.

## Command

```powershell
npm run obs:04:l1-latency -- --journal data/probes/infra01/data01a/l1-trade-journal.jsonl
```

JSON output is available for automation:

```powershell
npm run obs:04:l1-latency -- --journal data/probes/infra01/data01a/l1-trade-journal.jsonl --format json
```

If `--journal` is omitted, the command reads OBS-01 JSONL from stdin.

## Time Semantics

The dashboard follows ADR-0001:

- `exchange_event_ts_ns` is the canonical event timestamp.
- `sidecar_recv_ts_ns` is telemetry only.
- The latency metric is `sidecar_recv_ts_ns - exchange_event_ts_ns`.
- The dashboard does not call local wall-clock APIs.

Negative latency is surfaced as a warning because it indicates clock-sync, extraction, or
telemetry-ordering evidence that needs investigation. It does not rewrite event time.

## Output

The text dashboard reports:

- total valid OBS-01 events seen
- L1/trade events checked
- ignored non-L1/trade event count
- invalid row diagnostics
- QUOTE latency p50/p95/p99/max
- TRADE latency p50/p95/p99/max
- combined QUOTE/TRADE latency p50/p95/p99/max
- negative latency count

The JSON report carries:

- `partial_parity_status: L1_TRADE_ONLY_PASS`
- `data01_full_gate_status: BLOCKED`
- `data01b_status: BLOCKED_L2_L3_PARITY`

These fields are intentional guardrails. OBS-04 is operationally useful, but it must not be
used to advance DATA-01, SIM-02/SIM-03, RSRCH gates, REL-00, or REL-01.

## Scope Boundaries

OBS-04 is not a live socket dashboard and does not subscribe to Rithmic or Databento. It
only reads already-written journals.

OBS-04 does not classify quote gaps or session warmup. Those are handled by DATA-07a and
DATA-06a respectively.

OBS-04 does not inspect book-state parity. DATA-01B remains blocked pending Databento
MBP-10 and MBO availability plus parity evidence.

## Future Work

Once DATA-01B is unblocked, a later dashboard can add L2/L3 panels for MBP10/MBO freshness,
book authority, and depth-derived feature health. That work must use the DATA-01B verified
surface, not the DATA-01A L1/trade-only journal.
