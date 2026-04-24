# SIM-01 - Simulated Execution Adapter

Status: implemented

## Scope

V1 execution remains simulation-only. `apps/strategy_runtime/src/execution/simulated-execution.ts` provides the deterministic adapter used by later ORCH tickets to turn journaled order intents into simulated fills.

This ticket does not implement live order routing, Rithmic `ORDER_PLANT`, sockets, broker APIs, a runner loop, or position management.

## Adapter Behavior

The adapter accepts active APP-02 execution contracts:

- `SimulatedOrderIntent`
- `SimulatedOrderResult`
- `SimulatedFill`

It supports:

- `market`
- `limit`
- `stop_market`

Market orders fill immediately against the current BBO with configurable adverse slippage.

Limit orders use a conservative queue-aware simplification:

- marketable limits fill when they cross current BBO;
- adverse slippage is capped by the limit price;
- resting day/GTC limits are accepted with no fill;
- resting IOC limits are cancelled with no fill.

Stop-market orders fill only after the current BBO has crossed the stop trigger. Untriggered day/GTC stops are accepted with no fill.

## Costs

Fills include per-side commission and exchange fees from the RISK-01 venue-cost table. SIM-02/SIM-03 will replace the basic slippage assumptions with calibrated MNQ tick-data models.

## Determinism

The adapter uses no wall-clock, random numbers, locale formatting, sockets, or external services.

Callers provide:

- `submitted_ts_ns` on the order intent;
- market-state `ts_ns`;
- optional explicit `fill_ts_ns`.

Fill IDs are deterministic:

```text
fill-${order_intent_id}-1
```

## ORCH-02 Notes

ORCH-02 should:

- create order intents from approved candidates and sizing decisions;
- publish `ORDER_INTENT` before submitting to the adapter;
- publish `SIM_FILL` only from the returned fills;
- set event `ts_ns` via the EVT-01 causation chain, not `Date.now()`;
- journal venue-cost and execution-version lineage through producer metadata once the risk/sim config surface exists.
