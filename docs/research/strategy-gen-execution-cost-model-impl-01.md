# STRATEGY-GEN-EXECUTION-COST-MODEL-IMPL-01

## Determination

`EXECUTION_COST_MODEL_IMPL_READY_FOR_REVIEW`

## Scope

This implementation makes QFA-410B real-archive held-out artifacts cost true by default for MNQ strategy-generation runs.

Changed surfaces:

- `scripts/qfa-410b-execute.mts`
- `apps/backtester/src/held-out-validation/types.ts`
- `apps/backtester/src/held-out-validation/held-out-validation-runner.ts`

## Cost source

QFA-410B now loads MNQ costs from:

```text
config/venue-costs.json
```

Default MNQ model:

```text
commission_per_side_per_contract_usd = 0.40
exchange_fees_per_side_per_contract_usd = 0.35
round_turn_total_usd = 1.50
fees_enabled = true
```

The model is configurable with:

```text
--venue-costs <path>
--fees-enabled true|false
```

## Artifact additions

Held-out artifacts now include:

```text
cost_model
cost_model_config_hash
cost_adjusted_metrics.gross_pnl_cents
cost_adjusted_metrics.commission_cost_cents
cost_adjusted_metrics.exchange_fee_cost_cents
cost_adjusted_metrics.spread_slippage_cost_cents
cost_adjusted_metrics.total_execution_cost_cents
cost_adjusted_metrics.net_pnl_cents
cost_adjusted_metrics.profit_factor_gross_ppm
cost_adjusted_metrics.profit_factor_net_ppm
cost_adjusted_metrics.sharpe_gross
cost_adjusted_metrics.sharpe_net
cost_adjusted_metrics.dsr_net
```

Per-trade rows now include:

```text
commission_cost_cents
exchange_fee_cost_cents
spread_slippage_cost_cents
total_execution_cost_cents
pnl_basis
```

## Spread/slippage basis

The current QFA-410B real-archive execution path prices fills through the existing simulated fill prices and MBP/trade-derived fill context. This ticket records:

```text
spread_slippage_model = included_in_fill_prices_no_extra_adder
spread_slippage_cost_cents = 0
fill_prices_include_spread = true
```

No separate spread/slippage adder is introduced in this ticket; explicit calibrated adders remain a future extension if the execution simulator grows that model.

## Fail-closed guard

When `fees_enabled=true` and a run has trades, artifact generation fails if:

```text
total execution costs are zero
any trade has gross_pnl_cents == net_pnl_cents
```

This prevents trade-bearing QFA-410B artifacts from silently claiming `gating_pnl_basis = net` while using no-fee PnL.

## DSR boundary

`dsr_net` is present but intentionally `null` until `STRATEGY-GEN-CUMULATIVE-TRIAL-LEDGER-IMPL-01` lands. The artifact records:

```text
dsr_net_status = blocked_until_cumulative_trial_ledger
```

## Authority boundary

This implementation does not run strategy generation, QFA-611, paper trading, broker routing, roster mutation, or Phase 6 promotion. It only wires cost accounting into the held-out artifact production path.
