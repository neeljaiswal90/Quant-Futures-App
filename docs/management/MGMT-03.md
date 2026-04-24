# MGMT-03 - Position-Manager FSM

Status: implemented

## Scope

MGMT-03 adds the deterministic position-manager finite-state machine on top of MGMT-01 profiles and MGMT-02 target positions.

The implementation is pure TypeScript under:

```text
apps/strategy_runtime/src/management/position-manager/
```

It does not implement a runner loop, sockets, live execution, TUI behavior, or direct journal emission. ORCH-02 will wrap the returned payload summaries into OBS-01 envelopes.

## FSM States

The manager reports these states:

- `PLANNED`
- `OPEN`
- `PARTIAL`
- `BREAKEVEN_ARMED`
- `TRAILING_ACTIVE`
- `EXITED`
- `FAILED_SAFE_EXIT`
- `TIME_STOP_EXIT`

`TargetPosition.lifecycle_state` remains the lower-level MGMT-02 lifecycle (`planned`, `open`, `closing`, `closed`). The uppercase FSM state is the operator/decision view derived from target fills, break-even, trailing, and terminal reasons.

## Inputs

`evaluatePositionManager()` consumes:

- a MGMT-02 `TargetPosition`;
- its MGMT-01 `ManagementProfile`;
- caller-provided market facts;
- caller-provided `event_ts_ns` from the causation chain.

The market input supports:

- mark price;
- optional high/low prices;
- optional bid/ask;
- authority/stale flags for fail-safe checks.

All timestamps are injected by the caller. The manager never reads wall-clock time.

## Outputs

The manager returns:

- previous and updated target position;
- derived FSM state;
- deterministic management actions with stable IDs;
- `POSITION` payload summary;
- `MGMT_TICK` payload summary;
- `MGMT_ACTION` payload summaries;
- structured reason codes.

The output is designed for ORCH-02 to publish through OBS-01 / EVT-01. The manager itself does not emit journal events.

## Target Handling

Target hits are side-specific:

- long target hit: `high_price` or `mark_price` reaches/exceeds target;
- short target hit: `low_price` or `mark_price` reaches/falls below target.

Pending targets are evaluated in profile order. Filled targets are not filled again, preventing duplicate partial exits.

PT1 normally emits `TAKE_PARTIAL`. PT2 or a final target fill emits `TAKE_PROFIT`. Realized PnL and realized R are computed from journaled entry, target, quantity, and contract point value.

## Stop Handling

Initial stop hits are side-specific:

- long stop hit: `low_price` or `mark_price` reaches/falls below active stop;
- short stop hit: `high_price` or `mark_price` reaches/exceeds active stop.

Stop hits are terminal and emit `EXIT_FULL`.

Break-even moves are profile-driven. For the V1 profiles, break-even triggers after PT1. Long stops only move up; short stops only move down. The manager never moves a stop in the wrong direction.

## Trailing Behavior

Trailing activation is profile-driven. For the V1 profiles, trailing activates after PT1 and uses a tick distance.

After activation:

- long trailing stops ratchet upward only;
- short trailing stops ratchet downward only;
- no action is emitted when the proposed trail would move the stop backward.

Activation emits `ACTIVATE_TRAIL`; subsequent ratchets emit `MOVE_STOP`.

## Time Stop

Time-stop evaluation uses `event_ts_ns` compared with the target position's caller-provided `deadline_ts_ns`.

When the deadline is reached and the position is still open, the manager emits `TIME_STOP_EXIT` and closes the remaining quantity at the provided mark price.

## Fail-Safe Behavior

Fail-safe checks run first. The manager emits `FAIL_SAFE_EXIT` for dangerous state including:

- profile mismatch;
- stale/gap market input;
- invalid market price;
- missing/invalid active stop;
- invalid remaining quantity;
- invalid target-position validation.

Fail-safe exits are terminal. They do not block management of existing positions; they are the management path for invalid or dangerous state.

V1 uses this inline fail-safe path instead of the larger legacy `failure-exit/` curve subtree. The legacy curve model remains seed material for a future enhancement, but MGMT-03 intentionally keeps the V1 substrate explicit: validate state, close unsafe positions, and let ORCH-02 journal the reason.

`authority: 'warming'` is accepted in the input type for caller-side completeness, but ORCH-02 should not call the manager for planned/open positions while market data is warming. `authority: 'stale'` and `authority: 'gap'` are treated as dangerous for V1 and force a fail-safe exit rather than attempting to infer whether the feed hiccup is transient.

Session-close and roll-window flattening are out of scope for MGMT-03. ORCH-02 and DATA-06 own those calendar decisions and should route them through the same explicit management-action path.

## Determinism

The manager uses:

- no `Date.now`;
- no `new Date`;
- no random numbers;
- no locale-sensitive formatting;
- stable action ordering;
- deterministic action IDs derived from position id, event timestamp, ordinal, and action type.

Realized R is measured against the original target-position risk distance, not the mutable active stop after break-even or trailing moves.

Priority order is:

1. fail-safe;
2. stop hit;
3. target hits;
4. time stop;
5. break-even move;
6. trailing activation/ratchet.

## ORCH-02 Requirements

ORCH-02 should:

- create/open target positions after accepted simulated fills;
- call `evaluatePositionManager()` on market/bar/management ticks;
- publish `POSITION`, `MGMT_TICK`, and `MGMT_ACTION` envelopes from the returned payloads;
- set event `ts_ns` through EVT-01 causation inheritance, never runtime wall-clock time;
- preserve action ordering as returned by the manager.
