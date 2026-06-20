# Strategy generation candidate emitter impl 01

## Status

```text
ticket = STRATEGY-GEN-CANDIDATE-EMITTER-IMPL-01
determination = STRATEGY_GEN_CANDIDATE_EMITTER_IMPL_READY_FOR_BOUNDED_TIER1_RUN
scope_type = infrastructure_only
```

## Implemented surfaces

```text
config/strategy-gen/regime_shock_reversion_short_v2.search.yaml
scripts/strategy-gen/emit-tier1-candidates.ts
package.json
```

This ticket adds the deterministic Tier 1 candidate emitter that writes the
artifacts expected by the registry/trial-accounting substrate.

## Emitter command

```powershell
npm run strategy-gen:emit-tier1 -- --spec config/strategy-gen/regime_shock_reversion_short_v2.search.yaml
```

Dry-run mode:

```powershell
npm run strategy-gen:emit-tier1 -- --spec config/strategy-gen/regime_shock_reversion_short_v2.search.yaml --dry-run
```

## Emitted outputs

When run without `--dry-run`, the emitter writes:

```text
config/strategies/_candidates/<candidate_strategy_id>.yaml
apps/strategy_runtime/src/contracts/generated-candidate-strategy-ids.ts
artifacts/strategy-generation/<generation_run_id>/candidate-manifest.json
artifacts/strategy-generation/<generation_run_id>/trial-accounting-manifest.json
```

## Search spec

The first bounded search spec is intentionally small:

```text
base_strategy_id = regime_shock_reversion_short_v2
trial_budget = 6
parameter axes:
  low_shock_threshold_pos = 2.7, 2.8, 2.9
  target_1_rr = 1.2, 1.4
```

The corpus declaration is explicit and must travel into the candidate and
trial-accounting manifests:

```text
root = D:/qfa-cache/databento/mnq-continuous-12mo-2025-06-20_2026-06-20
surface = ohlcv_1m
session_scope = rth
required_feature_families = quote_mid|closed_1m_bar|session_vwap|signed_shock_vwap|regime_label
```

## Safety boundaries

This ticket does not run:

```text
strategy generation emitter
candidate backtest
held-out validation
QFA-611 gate
paper/shadow run
broker action
roster promotion
```

It only adds the deterministic emitter path. Generated candidates remain absent
until the emitter is explicitly run and its outputs are reviewed.

## Recommended next ticket

```text
STRATEGY-GEN-TIER1-BOUNDED-EMIT-01
```

Purpose:

```text
Run the emitter in a bounded Tier 1 mode, review exactly generated candidate
YAML / generated TS / candidate manifest / trial accounting manifest, and only
then decide whether to run candidate backtests.
```
