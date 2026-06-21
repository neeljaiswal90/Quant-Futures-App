# STRATEGY-GEN-REPORT-HARDENING-IMPL-01

## Determination

`REPORT_HARDENING_IMPL_READY_FOR_REVIEW`

## Implementation

QFA-611 now treats no-cost held-out artifacts as incomplete evidence. A complete artifact must include:

```text
cost_model
cost_model_config_hash
cost_adjusted_metrics
per-trade commission/exchange/total cost fields
pnl_basis = net_of_commission_exchange_fees_and_fill_prices
```

The selection JSON now records net-cost evidence fields including:

```text
pnl_basis
cost_model_config_hash
total_execution_cost_cents
profit_factor_gross
profit_factor_net
sharpe_gross
sharpe_net
dsr_net_status
```

The Markdown summary now records:

```text
effective_trial_count
effective_trial_count_source
PnL basis = net
per-strategy cost_model_config_hash
```

## Fail-closed behavior

QFA-611 returns `RESEARCH_FURTHER` for artifacts missing cost evidence rather than advancing or rejecting alpha on incomplete evidence.

## DSR boundary

`dsr_net_status` remains `blocked_until_cumulative_trial_ledger` at the artifact level until the strategy-generation loop supplies a campaign-complete ledger and the downstream statistical report consumes it.

## Authority boundary

No strategy generation, QFA-410B run, paper trading, broker routing, roster mutation, or Phase 6 promotion is authorized by this implementation.
