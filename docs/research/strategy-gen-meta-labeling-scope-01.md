# Strategy generation meta-labeling scope 01

## Status

```text
ticket = STRATEGY-GEN-META-LABELING-SCOPE-01
determination = STRATEGY_GEN_META_LABELING_SCOPE_READY_FOR_IMPL
scope_type = implementation_contract_only
depends_on = STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01
```

## Purpose

Define the contract for a secondary **meta-label** model that decides *whether to
act* on each primary-strategy signal (take/skip), to raise precision and therefore
profit factor. This directly attacks the failure mode where generated candidates
clear every gate except profit factor (1.22-1.25 versus the 1.35 floor). The
meta-model never changes the side; it only filters signals.

## Why this is the right lever (and the dangerous one)

```text
- Primary strategy = side + entry (unchanged). Secondary model = act / skip.
- Filtering false-positive signals raises precision -> raises PF without new families.
- It is ALSO the strongest overfitting lever in the plan: a flexible classifier can
  manufacture apparent PF lift by fitting noise. The controls below are what make it
  honest rather than a fast overfitting machine.
```

## Chosen design (this ticket)

```text
- Label horizon: triple-barrier on the candidate's OWN target_1 and stop levels (the
  strategy already defines its barriers); if neither barrier is hit, close at a bounded
  session/time horizon. The outcome is NET-OF-FEES via the cost model (PR #367): a
  signal is labeled a win only if net PnL > 0 after commissions.
- Feature seed: the existing point-in-time microstructure/context substrate already
  declared per family (e.g. quote_mid, closed_1m_bar, session_vwap, signed_shock_vwap,
  regime_label). Features are evaluated at or before signal time only.
- Classifier: gradient-boosted trees (auditable, handles tabular features and
  interactions), with a logistic-regression baseline retained for sanity comparison.
```

## Core contract

```text
1. Labels: triple-barrier outcome on the TRAIN partition using the candidate's own
   target/stop, NET-OF-FEES (cost model #367). Gross labels => reject.
2. Features: point-in-time only (data at/before signal time). Any feature using
   post-signal data => leakage => reject.
3. Training: TRAIN partition ONLY, walk-forward. Never trained on VALIDATION or HELD-OUT.
4. Evaluation: PF/precision lift measured on VALIDATION via the in-loop S score (#371),
   under nested cross-validation (#373). Confirmed ONCE on sealed held-out by the gate.
5. Model class: gradient-boosted trees plus a logistic baseline. No deep nets, no
   online learning in this ticket.
```

## Trial accounting and honesty (binding)

```text
- Every meta-model configuration / feature-set evaluated against data is a TRIAL and
  feeds the cumulative effective_trial_count (#368); the adaptive-search haircut applies.
- The take/skip filter is part of the candidate's identity: a candidate plus its
  meta-model is one gated unit with one parameter-lock hash.
- A meta-model that improves TRAIN but not VALIDATION is flagged and NOT promoted.
- Held-out is touched once, by the gate, after the meta-model is locked.
```

## Leakage controls

```text
- features <= signal time; labels from the barrier window only; net-of-fees labels.
- meta-model has NO held-out access (reuse the --allow-held-out-gate guard from #370).
- walk-forward retrain boundaries respect the data-split spine; no fold bleed.
- CI leakage test: a meta-model fed shuffled or future labels must NOT beat chance.
```

## Integration

```text
- The meta-gate sits between primary signal and order; skip => no trade in replay.
- Identical application in TRAIN/VALIDATION (S score) and at the gate.
- Survivor manifest (#372) records, per survivor, its meta-model fingerprint + feature set.
```

## Fail-closed

```text
- gross (not net-of-fees) labels                              => REJECT
- any held-out read during training or selection              => REJECT
- meta-model artifact missing fingerprint/feature-set/label-def => REJECT
- TRAIN-only improvement (no VALIDATION lift)                  => not promotable
- evaluated meta-models not counted as trials                 => REJECT
```

## Non-goals

```text
changing primary strategy logic; position sizing beyond take/skip; multi-class labels;
deep learning; online/streaming learning; cross-instrument transfer.
```

## Acceptance criteria (for IMPL-01)

```text
- meta-model trained TRAIN-only, walk-forward, net-of-fees labels
- demonstrable PF/precision lift on VALIDATION via the S score under nested CV
- every evaluated meta-model counted in the cumulative ledger; haircut applied
- one held-out confirmation, post-lock, through the gate
- CI leakage test (shuffled/future labels => no edge) passes
- byte-stable; fail-closed assertions enforced
```

## Recommended next ticket

```text
STRATEGY-GEN-META-LABELING-IMPL-01
```
