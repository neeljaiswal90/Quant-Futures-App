# EVT-00: Sidecar-to-Runtime Journal Transport

`EVT-00` defines the V1 transport between the Python market-data sidecar and the TypeScript strategy runtime.

The transport is intentionally simple:

- shared local folder / volume;
- append-only JSONL journal files;
- TypeScript watcher ingest;
- deterministic byte-offset checkpointing;
- malformed-line quarantine.

It does not use sockets, does not implement the runner, and does not recompute market, feature, strategy, risk, position, or fill facts.

## Scope Note

`EVT-00` enforces the source market-data canonical-time invariant:

```text
event.ts_ns === payload.exchange_event_ts_ns
```

Derived-event causation-chain timestamp inheritance is implemented by `EVT-01`. `ORCH-02` must not emit runner-derived events until that invariant is active, so derived events such as `FEATURES`, `STRAT_EVAL`, `CANDIDATE`, `RISK_GATE`, `SIZING`, `ORDER_INTENT`, `SIM_FILL`, `POSITION`, `MGMT_TICK`, and `MGMT_ACTION` cannot leak wall-clock time through `ts_ns`.

## Producer Contract

The sidecar writes one `JournalEventEnvelope` JSON object per line.

Required preservation fields:

- `run_id`;
- `session_id`;
- `event_id`;
- `causation_id` when applicable;
- `ts_ns`;
- `payload.exchange_event_ts_ns` for market-data events;
- `payload.sidecar_recv_ts_ns` for market-data telemetry;
- `payload`.

For market-data events, `ts_ns` must equal `payload.exchange_event_ts_ns`. `sidecar_recv_ts_ns` is telemetry only and must not become canonical event time.

## Atomic Write Rule

Active journal files are append-only `*.jsonl`.

Rotation rule:

1. Continue appending complete newline-terminated JSONL records to the active file.
2. If a producer prepares a rotated replacement, write it with a temporary suffix such as `.tmp`, `.partial`, or `.writing`.
3. Rename the completed file to `*.jsonl` only after all lines are complete.

The runtime ingestor ignores temporary suffixes and processes `*.jsonl` files in deterministic lexicographic order.

If the final line in an active file does not yet have a newline terminator, the runtime treats it as incomplete:

- do not parse it;
- do not quarantine it;
- do not advance the checkpoint past it;
- retry on the next poll or file-watch event.

## Checkpointing

The runtime writes a checkpoint file under:

```text
<journal_dir>/.checkpoints/runtime-ingest-checkpoint.json
```

The checkpoint stores, per file:

- byte offset;
- line number;
- last ingested event id.

On restart, ingest resumes from the recorded byte offset. Already-ingested records are not re-emitted.

Partial trailing lines are not checkpointed until the terminating newline arrives.

## Quarantine

Malformed records are appended to:

```text
<journal_dir>/quarantine/malformed-lines.jsonl
```

A malformed line does not stop ingestion. The checkpoint advances past the quarantined line so restart does not repeatedly quarantine the same bad record.

Quarantine records include source file, line number, byte offsets, raw line, and error message. They intentionally do not include a wall-clock `quarantined_at` field in V1 so transport output stays deterministic.

## TypeScript API

The runtime-side API lives in:

```text
apps/strategy_runtime/src/transport/journal-jsonl-transport.ts
```

Use `JsonlJournalTransportIngestor.start()` for watcher mode, or `pollOnce()` for deterministic tests and replay-style ingestion.
