# Strategy generation execution cost model scope 01

## Status

```text
ticket = STRATEGY-GEN-EXECUTION-COST-MODEL-SCOPE-01
determination = STRATEGY_GEN_EXECUTION_COST_MODEL_SCOPE_READY_FOR_IMPL
scope_type = implementation_contract_only
depends_on = STRATEGY-GEN-FOLD-LANDING-01
```

## Purpose

Define the contract for charging realistic execution costs in QFA-410B held-out
replay so that net PnL, profit factor, Sharpe, expectancy, and DSR are
**cost-true**. This is the P0 gate to trustworthy numbers: until it lands, every
downstream metric and every optimizer is operating on a fiction.

## Problem evidence (this cycle)

```text
- In the full-loop run, per-trade gross_pnl_cents == net_pnl_cents for every trade.
- Trades exit at +$0.50 net (one MNQ tick) which is impossible to be net-positive
  after any real commission.
- Average edge is ~$1.76/trade (~3.5 ticks); spread/queue slippage is modeled but
  commissions are not.
- At realistic MNQ commissions the top candidate profit factor falls from 1.256 to
  roughly 1.0-1.1 (negative at full retail).
=> The backtest charges no commissions. Commissions must be charged before any
   further loop work.
```

## Cost components (in scope)

```text
1. Broker commission   per contract, per side
2. Exchange fee (CME)   per contract, per side
3. Clearing fee         per contract, per side
4. Regulatory (NFA) fee per contract, per side
   total per-side cost = sum of the above; round trip = entry side + exit side
   scales linearly with contract count and with partial fills (per executed contract)
5. Spread / slippage    ALREADY modeled via fill prices (spread_bucket / queue_ahead_bucket)
   stays in gross; the cost model must NOT double count it
```

## Gross / net semantics (the core contract)

```text
gross_pnl_cents = PnL from executed fill prices (already includes spread/queue slippage)
net_pnl_cents   = gross_pnl_cents - total_commission_cents
profit_factor, sharpe, expectancy, DSR, in-loop S score => all computed on NET

artifact must carry, per trade and in aggregate:
  gross_pnl_cents, commission_cents, net_pnl_cents   (three distinct fields)
```

## MNQ fee schedule (configurable, recorded, never hardcoded)

```yaml
cost_model:
  schema_version: 1
  currency: USD
  per_side_cents:
    broker_commission: <configurable>
    exchange_fee: <configurable>
    clearing_fee: <configurable>
    regulatory_fee: <configurable>
  round_trip_cents: <derived = 2 x sum(per_side_cents)>
  source: <broker/tier provenance string>
  cost_model_fingerprint: <sha256>
```

Calibration target: a realistic MNQ all-in round trip is roughly **$1.00-$1.50
retail**; the exact broker/tier value must be confirmed and is recorded in the
artifact, never silently assumed. A conservative documented default with a
per-run override.

## Integration points

```text
- QFA-410B held-out replay PnL accounting (position-manager FSM / execution sim output).
- The SAME cost model must apply in TRAIN/VALIDATION (the in-loop S score) and at the
  gate; costs are universal, not gate-only.
- effective-trial accounting and held-out sealing are unaffected.
```

## Fail-closed assertions

```text
- fees configured > 0 AND any trade gross == net           => REJECT (the bug found this cycle)
- real run with no cost_model configured                   => REJECT (no silent zero-fee runs)
- a zero-fee run is allowed ONLY via explicit --zero-fee, is stamped
  diagnostic_zero_fee=true in the artifact and report, and is never promotable
- cost_model_fingerprint missing from artifact             => REJECT
- non-deterministic or non-byte-stable cost computation    => REJECT
```

## Non-goals

```text
funding/borrow/overnight (intraday futures), margin, tax, tiered volume discounts,
changes to the spread/queue slippage model, multi-instrument fee tables.
```

## Acceptance criteria (for IMPL-01)

```text
- re-run regime-shock-v2-tier1: net < gross per trade, commission line present,
  profit factor recomputed on net
- a +$0.50 (one-tick) gross win becomes net-negative after a round-trip commission
- TRAIN/VALIDATION S score and held-out gate both consume net
- cost_model schedule + fingerprint recorded in held-out artifact and analysis report
- gross == net with fees > 0 fails closed; report distinguishes diagnostic_zero_fee runs
- byte-stable across repeated replays
```

## Recommended next ticket

```text
STRATEGY-GEN-EXECUTION-COST-MODEL-IMPL-01
```
