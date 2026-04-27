# DATA-01A: L1/Trade-Only Canonical Ingestion

DATA-01A is a narrow preparatory split from DATA-01. It exists because INFRA-01 evidence is
currently partial: Rithmic rich capture works and Databento `trades`/`mbp-1` cover the
Rithmic window, but Databento `mbp-10` and `mbo` parity are not complete.

DATA-01 remains blocked as a full gate. DATA-01B remains blocked for L2/L3 parity.

## Allowed Scope

- `LAST_TRADE` ingestion.
- `L1_QUOTE` / BBO ingestion.
- `exchange_event_ts_ns` as canonical event time.
- `sidecar_recv_ts_ns` as telemetry only.
- OBS-01 `TRADE` and `QUOTE` source event output.
- Partial parity status recorded as `L1_TRADE_ONLY_PASS`.

## L1 Quote Reconstruction

Rithmic `L1_QUOTE` rows can be side-specific state updates rather than complete BBO
snapshots. A row may carry only the bid side or only the ask side. DATA-01A therefore
maintains an in-memory BBO state while reading the probe/provider stream:

- bid-only rows update the current bid state.
- ask-only rows update the current ask state.
- no `QUOTE` event is emitted until both sides are known.
- after both sides are known, every bid or ask update emits a complete OBS-01 `QUOTE`
  carrying the reconstructed BBO.

The reconstruction is deterministic and uses `exchange_event_ts_ns` from the row that
caused the emitted BBO update. `sidecar_recv_ts_ns` remains telemetry only.

## Explicitly Blocked

- MBP10 production feature gates.
- MBO production feature gates.
- OFI, depth, queue, or MBO-derived features marked verified.
- SIM-02 / SIM-03 calibration.
- ML dataset generation.
- RSRCH or REL gate advancement from partial evidence.

## Sidecar Command

Convert a rich Rithmic probe/provider JSONL into an OBS-01 L1/trade journal:

```powershell
npm run data:01a:l1-trade -- `
  --input data/probes/infra01/full/probe-parity.jsonl `
  --out data/probes/infra01/data01a/l1-trade-journal.jsonl `
  --report reports/infra/data01a_l1_trade_report.json `
  --run-id data01a-rithmic-probe `
  --session-id 2026-04-26-rth
```

The command is offline-safe. It does not connect to Rithmic, Databento, sockets, or live
execution. It reads an existing rich probe/provider JSONL and emits only `QUOTE` and `TRADE`
source events.

Large probes are written as a streaming conversion; the publisher does not buffer the full
OBS-01 journal in memory.

## Timestamp Rule

For every emitted source event:

```text
event.ts_ns == payload.exchange_event_ts_ns
```

`payload.sidecar_recv_ts_ns` is preserved for telemetry and never used as canonical event
time. Rows missing `exchange_event_ts_ns` are skipped and counted in the report.

## L2/L3 Guardrail

Rows from `MBP10` and `MBO` are skipped and counted. They are not transformed, journaled, or
used for features in DATA-01A. Full DATA-01 closure still requires:

- Databento `mbp-10` availability.
- Databento `mbo` availability.
- Normalized Databento exports.
- MBP10 reconstructed-state parity.
- MBO event/action parity.
- A passing revised INFRA-01 verification report.
