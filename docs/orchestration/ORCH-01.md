# ORCH-01: Event Bus And Engine Container

`ORCH-01` adds the in-process runtime substrate used by the later runner loop.

It does not implement `ORCH-02`, strategy scheduling, live execution, sockets, order entry, or a console runner shell.

## Files

```text
apps/strategy_runtime/src/orchestration/
  event-bus.ts
  engine-container.ts
  index.ts
```

## Event Bus

`RuntimeEventBus` is a deterministic in-process publish/subscribe bus over OBS-01 journal events.

It provides:

- `publish(event)` for validated `JournalEventEnvelope` facts;
- `subscribe({ channels, event_types }, handler)` for explicit subscriptions;
- `subscribeToSubscriberProfile(profile, handler)` for TUI-01 profiles such as `TUI`, `FORMATTER`, `JOURNAL_QUERY`, `ALERTS`, and `REPLAY`;
- deterministic subscription ordering;
- a monotone bus-head timestamp via `getHeadTsNs()`;
- a bounded causation buffer for derived-event timestamp inheritance.

The bus routes events through the TUI-01 channel contract with raw diagnostic channels available where the contract defines them. For example, `QUOTE` publishes on both `MARKET` and explicit-opt-in `QUOTE_RAW`; the default `TUI` profile still excludes `QUOTE_RAW`.

## Validation

Publishing applies the same architecture rules as the transport layer:

1. OBS-01 schema validation.
2. Source market-data canonical time:

```text
event.ts_ns === payload.exchange_event_ts_ns
```

3. Derived-event causation time:

```text
event.causation_id is required
event.ts_ns === causation_event.ts_ns
```

The bus records an accepted event in its causation buffer before handlers run. This allows a handler to synchronously publish a derived event caused by the current event without reaching for wall-clock time.

## Engine Container

`createStrategyRuntimeEngineContainer()` owns:

- loaded APP-03 config and lineage;
- the runtime event bus;
- EVT-00 journal transport config derived from `publicConfig.paths.journal_dir`;
- a transport-ingestor adapter that publishes ingested JSONL events onto the bus.

The container is intentionally a dependency holder. It does not run strategies, sidecar polling, simulated execution, position management, or replay.

## Determinism

`ORCH-01` avoids:

- `Date.now`;
- `new Date`;
- `Math.random`;
- locale-sensitive formatting;
- wall-clock freshness decisions;
- unordered subscriber delivery.

The event bus head timestamp is derived only from accepted event `ts_ns` values. `TUI-03` and later live operator surfaces should use that head timestamp as their render-time source in `REL-00`.

## ORCH-02 Handoff

`ORCH-02` should consume this substrate rather than creating a separate event shell:

- instantiate/load config with APP-03;
- create one `StrategyRuntimeEngineContainer`;
- attach sidecar/replay journal ingestion through the container;
- emit every runtime fact as an OBS-01 event envelope through `RuntimeEventBus.publish`;
- keep derived `ts_ns` inherited from causation, never from wall clock.

