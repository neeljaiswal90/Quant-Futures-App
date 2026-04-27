# DATA-06A: L1/Trade Session Clock And Warmup Suppression

DATA-06A adds an offline-safe session clock and warmup report for the DATA-01A verified
surface:

- `L1_QUOTE`
- `LAST_TRADE`

It does not enable MBP10 or MBO ingestion. Full DATA-01 remains blocked until DATA-01B
proves MBP10/MBO Databento parity.

## Scope

DATA-06A reads the same rich Rithmic probe/provider JSONL accepted by DATA-01A. It reuses
the DATA-01A normalizer, so only rows that can become OBS-01 `QUOTE` or `TRADE` source
events enter session classification. Rows from `MBP10` and `MBO` are counted as blocked
diagnostics.

The clock classifies each verified row using `exchange_event_ts_ns` only:

- `rth`
- `eth`
- `maintenance`
- `closed`

`sidecar_recv_ts_ns` is preserved in transition diagnostics as telemetry, but it is never
used to classify the session or warmup state.

## Warmup Policy

The V1 default suppresses candidate eligibility for the first 60 seconds after RTH open.
This mirrors the broader MNQ-01/ORCH policy that strategies are RTH-only and should not
trade during the initial reconvergence window.

Warmup suppression is reported with:

```text
block_reason = warmup_suppression
candidate_eligible = false
warmup_suppressed = true
```

Outside RTH, candidate eligibility is still blocked with the same stable reason semantics
used by MNQ-01:

- `outside_rth`
- `maintenance_halt`
- `session_closed`

## Command

```powershell
npm run data:06a:session-warmup -- `
  --input data/probes/infra01/full/probe-parity.jsonl `
  --report reports/infra/data06a_session_warmup_report.json
```

Optional warmup override:

```powershell
npm run data:06a:session-warmup -- `
  --input data/probes/infra01/full/probe-parity.jsonl `
  --report reports/infra/data06a_session_warmup_report.json `
  --warmup-sec 60
```

## Report Fields

The report includes:

- `status`
- `verified_l1_trade_rows`
- `phase_counts`
- `block_reason_counts`
- `candidate_eligible_count`
- `warmup_suppressed_count`
- `transition_count`
- `transitions`
- `skipped_mbp10_rows`
- `skipped_mbo_rows`
- `diagnostic_counts`
- `partial_parity_status: L1_TRADE_ONLY_PASS`
- `data01_full_gate_status: blocked`
- `data01b_status: blocked_l2_l3_parity`

The `transitions` array is journal-ready for later `SESSION_PHASE` emission, but DATA-06A
does not emit journal events directly.

## DATA-01 Guardrail

DATA-06A improves offline readiness by making L1/trade session and warmup behavior
auditable against captured probes. It does not advance DATA-01, SIM, ML, RSRCH, or REL
gates. L2/L3 work remains blocked until:

- Databento `mbp-10` is available.
- Databento `mbo` is available.
- MBP10 reconstructed-state parity passes.
- MBO event/action parity passes.
- The revised INFRA-01 verification report routes to DATA-01.
