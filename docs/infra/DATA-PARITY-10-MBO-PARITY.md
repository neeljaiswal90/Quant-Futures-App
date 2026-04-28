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

## DATA-PARITY-11 Action Taxonomy Review

DATA-PARITY-11 extends the same CLI with a nested `mbo_action_taxonomy` section. This is a
review tool for deciding whether the cross-source MBO mismatch is caused by provider action
taxonomy rather than missing or corrupt data.

The taxonomy report includes:

- action counts and percentages by provider;
- side counts by action;
- price, size, order ID, and sequence availability by action;
- first deterministic examples per action category;
- the current normalized action-mapping table with rationale;
- alternate signature modes that include or exclude `trade` and `unknown` actions;
- event-semantics decomposition for Databento-only events;
- timestamp-window sensitivity for structural book actions;
- sequence and order-ID overlap diagnostics.

The action-mapping table is intentionally evidence, not policy. It records whether each
raw provider action is currently included in signature parity and feature parity, but it
does not by itself accept MBO parity or enable MBO-derived features.

Alternate signature modes:

- `strict_all_actions`: include every normalized action.
- `exclude_unknown`: exclude only `unknown`.
- `exclude_trade`: exclude only `trade`.
- `exclude_trade_and_unknown`: exclude both `trade` and `unknown`.
- `structural_book_actions_only`: include only `add`, `modify`, and `cancel` actions that
  represent resting book-state changes under the current taxonomy.

`trade` and `unknown` categories are not automatic parity failures. Databento may expose
execution or control-like events in `mbo` that Rithmic exposes through another stream or
filters from MBO. The taxonomy review must show whether excluding those categories leaves a
strong structural book-action match before a reviewer can write policy.

DATA-01B remains blocked for every DATA-PARITY-11 classification. If structural book-action
parity looks strong with `trade`/`unknown` excluded, the next step is an ADR or INFRA policy
decision that explicitly states which categories are hard-gated and which remain diagnostic.

## INFRA-01F Policy Decision

INFRA-01F accepts MBO as a provider-internal sub-scope after reviewing the DATA-PARITY-10
and DATA-PARITY-11 evidence. This is not a claim of Rithmic-vs-Databento order-by-order
byte identity.

Accepted:

- provider-internal order lifecycle tracking;
- single-provider queue-position estimation for SIM calibration;
- MBO-derived microstructure features that operate within one provider's replay path.

Diagnostic only:

- Databento `trade`/`unknown` action equivalence to Rithmic streams;
- cross-source order ID byte identity;
- cross-feed order-by-order replay parity.

The safe decision report is generated with:

```powershell
npm run infra:01f:decision -- --out reports/infra/infra01f_mbo_policy_decision_post04d_summary.json
```

`DATA-01B` full scope still requires implementation evidence after this policy decision:
the MBO consumer, DATA-03 authority FSM, DATA-04 feature engine, SIM calibration, and REL
provider-internal replay evidence are separate gates.

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

DATA-PARITY-11 taxonomy classifications:

- `book_action_parity_pass_trade_excluded`: structural `add`/`modify`/`cancel` parity is
  strong after excluding trade/unknown actions; reviewer policy is still required.
- `action_taxonomy_mismatch`: trade/unknown action taxonomy explains a material part of the
  mismatch, but structural parity is not yet a pass.
- `trade_action_semantics_mismatch`: Databento `trade` actions dominate unmatched events;
  add or document Rithmic trade-action normalization before accepting MBO parity.
- `unknown_action_mapping_required`: Databento `unknown` actions dominate unmatched events;
  inspect raw examples and map the category manually.
- `structural_mbo_parity_failure`: structural book-action mismatch remains after taxonomy
  filtering; keep DATA-01B blocked and inspect raw provider examples.
- `inconclusive_mbo_taxonomy`: evidence is mixed or insufficient.

## Gate Impact

INFRA-01F is the explicit policy decision that accepts MBO as a provider-internal
sub-scope. After INFRA-01F:

- full `DATA-01B` is still not automatically passed;
- MBO consumers and queue-position features require implementation evidence;
- SIM-02/SIM-03 queue-aware calibration remains blocked until the MBO consumer and
  provider-internal replay path exist;
- ML, RSRCH, and REL gates depending on full L2/L3/MBO evidence remain blocked until their
  own implementation and replay evidence exists.

Raw Rithmic probes, Databento DBN files, and normalized large JSONL artifacts must remain
uncommitted.
