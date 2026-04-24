# EVT-01: Derived-Event Causation Timestamp Invariant

`EVT-01` extends the EVT-00 JSONL transport with a deterministic causation-chain timestamp invariant.

The goal is to prevent wall-clock leakage through derived runtime events before `ORCH-02`.

## Event Categories

Source market-data events:

- `QUOTE`
- `TRADE`
- `BAR_CLOSE`
- `MICROSTRUCTURE`
- `BOOK_REBUILD`

System/control events:

- `CONN`
- `FEED`
- `GAP`
- `SESSION_PHASE`
- `ROLL_ADVISORY`
- `HALT`
- `CONFIG`

Derived events:

- `FEATURES`
- `STRUCTURE`
- `STRAT_EVAL`
- `CANDIDATE`
- `ML_UPLIFT`
- `RANK`
- `RISK_GATE`
- `SIZING`
- `ORDER_INTENT`
- `SIM_FILL`
- `POSITION`
- `MGMT_TICK`
- `MGMT_ACTION`

## Invariants

Source market-data events require:

```text
event.ts_ns === payload.exchange_event_ts_ns
```

Derived events require:

```text
event.causation_id is present
event.ts_ns === causation_event.ts_ns
```

The transport does not rewrite `ts_ns`; it rejects/quarantines mismatches.

System/control events are explicitly exempt from `causation_id` because they can represent connection/session facts rather than downstream decisions.

## Recent Causation Buffer

The transport keeps a deterministic recent-causation buffer:

- keyed by `event_id`;
- stores `event_id`, `ts_ns`, `type`, and optional `causation_id`;
- size-bounded only;
- no wall-clock eviction;
- persisted inside the transport checkpoint for deterministic restart behavior.

If a derived event's cause is not available in the recent buffer, the event is quarantined unless it is an explicitly exempt system/control event.

## Quarantine Metadata

Causation and timestamp violations quarantine the raw line with:

- `source_file`;
- `line_number`;
- `byte_offset_start`;
- `byte_offset_end`;
- `raw_line`;
- `error_message`;
- `event_id` when parseable;
- `causation_id` when parseable;
- `event_type` when parseable.

No `quarantined_at` timestamp is added because the transport output must remain deterministic.

## Producer Requirement

Producer and event-bus code must emit derived events with `causation_id` and must inherit `ts_ns` from the triggering event, not from runtime wall clock.

`ORCH-02` remains blocked until this invariant is merged.
