# MGMT-02 - Target-Position Model

Status: implemented

## Scope

MGMT-02 adds the deterministic target-position model used by later position-management tickets. It converts a journaled candidate plus an MGMT-01 management profile into a planned target position, then applies the initial simulated fill to produce an open target-position state.

This ticket does not implement the full position manager loop, action decision engine, runner wiring, sockets, live execution, TUI behavior, or order routing.

## Core Module

Implementation:

```text
apps/strategy_runtime/src/management/target-position.ts
```

Exports:

- `buildTargetPositionFromCandidate`
- `applyInitialFillToTargetPosition`
- `computePartialTargetQuantities`
- `validateTargetPosition`
- `summarizeTargetPositionForJournal`

## Target-Position Fields

Each target position carries:

- `position_id`
- `candidate_id`
- optional `fill_id`
- `strategy_id`
- instrument identity
- side
- lifecycle state
- quantity and remaining quantity
- entry price
- initial stop and active stop
- risk points
- PT1/PT2 target plan
- break-even trigger metadata
- trailing-stop activation metadata
- time-stop metadata
- fail-safe policy metadata
- `profile_id`, `profile_version`, and profile hash placeholder
- caller-provided `opened_ts_ns` and `updated_ts_ns`
- realized/unrealized PnL placeholders
- deterministic reasons

## Side-Specific Geometry

Long positions require:

- stop below entry;
- targets above entry;
- `risk_points = entry - stop`;
- target reward-risk = `(target - entry) / risk_points`.

Short positions require:

- stop above entry;
- targets below entry;
- `risk_points = stop - entry`;
- target reward-risk = `(entry - target) / risk_points`.

Validation rejects invalid stop/entry ordering, invalid target ordering, reward-risk mismatches, non-positive quantities, and profile metadata mismatches.

## Partial Quantities

`computePartialTargetQuantities()` converts profile target fractions into deterministic integer quantities.

For the V1 50/50 PT1/PT2 profiles:

- even quantities split evenly;
- odd quantities assign the deterministic remainder to the final target;
- total target quantity must not exceed total position quantity.

## Fill Application

`buildTargetPositionFromCandidate()` creates a planned target position from candidate/profile facts and caller-provided `opened_ts_ns`.

`applyInitialFillToTargetPosition()` validates the simulated fill side/instrument, uses the actual fill price and fill quantity, preserves `candidate_id` / `fill_id` lineage, and recomputes side-specific risk and target reward-risk from the actual fill price.

## Journal Readiness

`summarizeTargetPositionForJournal()` returns stable summary fields for future `POSITION`, `MGMT_TICK`, and `MGMT_ACTION` producers:

- position and candidate lineage;
- fill lineage when available;
- profile id/version/hash;
- side/status/quantity;
- entry, active stop, and targets;
- realized/unrealized PnL placeholders;
- `updated_ts_ns`.

Future producers must still emit OBS-01 envelopes through EVT-01 causation rules. Event `ts_ns` must inherit from the causal market/candidate/fill chain, not runtime wall-clock time.

## Deferred Work

MGMT-03 should consume this model to implement the position-manager FSM:

- target fills;
- stop movement;
- break-even marking;
- trailing activation and movement;
- fail-safe exits;
- time-stop exits;
- lifecycle transitions.

ORCH-02 should wire target-position creation after simulated entry fills and journal resulting `POSITION` facts.
