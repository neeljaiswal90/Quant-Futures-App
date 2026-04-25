# OBS-01: Formal Journal/Event Schema

`OBS-01` defines the V1 journal event schema consumed by producers, replay, formatter, TUI, transport, and later research tooling.

The journal remains JSONL: one deterministic event envelope per line.

## Envelope

Every event uses schema version `1`:

```ts
JournalEventEnvelope<TType, TPayload>
```

Required fields:

- `schema_version`: must be `1`;
- `run_id`;
- `session_id`;
- `event_id`;
- `type`;
- `ts_ns`;
- `payload`.

Conditional fields:

- `causation_id`: required for derived events;
- `correlation_id`: optional cross-chain grouping;
- `config`: optional config lineage reference with `config_hash` and `config_version`.

Unknown schema versions and unknown event types are rejected and quarantined by the transport.

## Payload Map

Payload types are defined in:

```text
apps/strategy_runtime/src/contracts/events/payloads.ts
```

The current V1 event set covers:

- Source market data: `QUOTE`, `TRADE`, `BAR_CLOSE`, `MICROSTRUCTURE`, `BOOK_REBUILD`.
- System/control: `CONN`, `FEED`, `GAP`, `SESSION_PHASE`, `ROLL_ADVISORY`, `HALT`, `CONFIG`.
- Feature/structure: `FEATURES`, `STRUCTURE`.
- Strategy/candidate: `STRAT_EVAL`, `CANDIDATE`, `ML_UPLIFT`, `RANK`, `RISK_GATE`, `SIZING`.
- Simulation/position: `ORDER_INTENT`, `SIM_FILL`, `POSITION`, `MGMT_TICK`, `MGMT_ACTION`.

Runtime validation lives in:

```text
apps/strategy_runtime/src/contracts/events/schema.ts
```

The validator returns structured issues with stable `path`, `code`, and `message` fields. It does not throw opaque exceptions.

`SESSION_PHASE.phase` supports explicit `rth`, `eth`, `maintenance`, `closed`, `halted`, and `pre_open` values. MNQ V1 uses `eth` directly for electronic trading windows rather than mapping ETH to `pre_open`.

## Timestamp Rules

ADR-0001 remains authoritative.

For source market-data events:

```text
event.ts_ns === payload.exchange_event_ts_ns
```

`payload.exchange_event_ts_ns` is required.

`payload.sidecar_recv_ts_ns` is receive-time telemetry only and must not become canonical replay, label, feature-alignment, or candidate-lineage time.

For derived events:

```text
event.causation_id is required
event.ts_ns === causation_event.ts_ns when the cause is available
```

The transport does not rewrite event facts. Invalid events are quarantined.

System/control events are explicitly exempt from `causation_id` because they can represent connection, session, feed, roll, halt, or config facts rather than downstream trading decisions.

## Transport Validation Order

The JSONL transport applies checks in this order:

1. Parse JSON and revive nanosecond timestamp strings to branded bigint timestamps.
2. Validate the OBS-01 envelope and event-specific payload schema.
3. Enforce the EVT-00 source market-data canonical-time invariant.
4. Enforce the EVT-01 derived-event causation-chain timestamp invariant.

This order keeps malformed schema events out before timestamp/cause semantics are evaluated.

## Quarantine

Schema-invalid events are quarantined with the same deterministic metadata as malformed JSONL:

- `source_file`;
- `line_number`;
- `byte_offset_start`;
- `byte_offset_end`;
- `raw_line`;
- `error_message`;
- `event_id` when parseable;
- `event_type` when parseable;
- `causation_id` when parseable.

No wall-clock `quarantined_at` field is emitted in V1.

## TUI And Formatter Consumption

`TUI-01` and `TUI-02` must consume journal/event facts directly from these envelopes and payloads.

They must not recompute indicators, strategy gates, candidates, risk decisions, sizing, fills, positions, or management actions.

Formatter output should be derived from validated OBS-01 events and should preserve deterministic ordering and timestamp string semantics for replay parity.
