# Databento Overlap Parity

Databento overlap parity is the evidence review that compares a Rithmic probe against
Databento historical data for the same MNQ contract and exchange-time window.

This review does not unblock `DATA-01` by itself. `DATA-01` remains blocked until the
final INFRA-01 verification report explicitly says `data01_eligible = true` and
`route_to = DATA-01`.

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
