# DATA-PARITY-10: MBO Event/Action Parity Diagnostic

DATA-PARITY-10 validates whether Rithmic and Databento MBO streams expose compatible
event semantics for V1. It is an offline diagnostic. It does not unblock full `DATA-01B`
by itself.

## Scope

The diagnostic compares normalized Rithmic rich-probe `MBO` rows against normalized
Databento `mbo` JSONL rows.

It reviews:

- event/action distribution;
- side distribution;
- price tick alignment;
- size distribution;
- sequence coverage and non-decreasing behavior;
- order-id availability;
- coarse one-second action/side/price/size signature overlap.

It does not require Rithmic and Databento order IDs to be byte-identical. Order ID parity is
diagnostic only until both feeds are proven to expose compatible native CME order IDs and
lifecycle semantics.

## Command

```powershell
npm run infra:analyze-mbo-parity -- `
  --rithmic-probe data/probes/infra01/full/probe-parity-post04d.jsonl `
  --databento-mbo data/probes/infra01/full/databento/MNQM6_mbo_post04d.normalized.jsonl `
  --out reports/infra/mbo_parity_report_post04d.json
```

The report remains `status: "analysis_only"` and always keeps
`data01b_full_eligible: false`. A later policy decision must review the report before MBO
features can be enabled.

## Classifications

- `mbo_event_semantics_aligned`: action, side, price, size, and sequence evidence look
  compatible enough for reviewer consideration.
- `mbo_action_side_mismatch`: action or side distributions differ materially.
- `mbo_price_size_mismatch`: price tick alignment or size semantics fail sanity checks.
- `mbo_sequence_semantics_mismatch`: sequence values decrease or have incompatible
  ordering behavior.
- `mbo_order_id_semantics_incompatible`: order ID coverage or compatibility is not strong
  enough for order-id-based gates.
- `inconclusive`: evidence is insufficient or mixed.

## Gate Impact

Until an explicit policy decision accepts MBO parity:

- full `DATA-01B` remains blocked;
- MBO-derived features remain blocked;
- queue-position and order-level features remain blocked;
- SIM-02/SIM-03 queue-aware calibration remains blocked;
- ML, RSRCH, REL gates depending on full L2/L3/MBO evidence remain blocked.

If a later policy accepts MBO parity, it should update ADR-0002 or add a new ADR and should
write a safe INFRA decision report. Raw Rithmic probes, Databento DBN files, and normalized
large JSONL artifacts must remain uncommitted.
