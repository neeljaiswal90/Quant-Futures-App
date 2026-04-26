# TUI-01: Operator Event-Bus Contract

`TUI-01` defines the read-only operator-surface contract for V1.

The operator surface renders journaled/event-bus facts. It must not recompute indicators, structure, strategy gates, candidates, risk decisions, sizing, orders, fills, position state, or management actions.

## Channels

The contract lives in:

```text
apps/strategy_runtime/src/contracts/events/channels.ts
```

Required default TUI channels:

| Channel | Event types | Cadence / throttling |
|---|---|---|
| `CONNECTION` | `CONN`, `FEED`, `GAP`, `BOOK_REBUILD` | 1 Hz event-time heartbeat/throttle plus event-driven facts |
| `SESSION` | `SESSION_PHASE`, `ROLL_ADVISORY`, `HALT` | event-driven |
| `MARKET` | `QUOTE`, `TRADE`, `BAR_CLOSE` | `QUOTE` throttled to 5 Hz using `event.ts_ns`; trades and bars are facts |
| `INDICATORS` | `FEATURES` | per bar close |
| `STRUCTURE` | `STRUCTURE` | per bar close plus structure events |
| `MICROSTRUCTURE` | `MICROSTRUCTURE` | 2 Hz using `event.ts_ns` |
| `STRATEGY_GATES` | `STRAT_EVAL` | per evaluation cycle |
| `CANDIDATES` | `CANDIDATE`, `ML_UPLIFT`, `RANK`, `RISK_GATE`, `SIZING` | event-driven |
| `ORDERS` | `ORDER_INTENT`, `SIM_FILL`, `EXEC_REJECT` | event-driven |
| `POSITION` | `POSITION`, `MGMT_TICK`, `MGMT_ACTION` | event-driven plus per-bar management ticks |

Additional non-default channels:

| Channel | Purpose |
|---|---|
| `QUOTE_RAW` | Explicit opt-in raw quote stream for diagnostics/replay. It is not a default TUI input. |
| `CONFIG` | Config lineage facts for replay, formatter, and journal query surfaces. |

## Subscriber Profiles

The contract declares subscriber channel sets for:

- `TUI`;
- `FORMATTER`;
- `JOURNAL_QUERY`;
- `ALERTS`;
- `REPLAY`.

The default `TUI` profile excludes `QUOTE_RAW` and `CONFIG`. `QUOTE_RAW` is available only to explicit diagnostic/replay subscribers.

## Throttling Rule

Throttling uses event time, not wall clock:

```text
source_clock = event_ts_ns
selection = latest_event_per_window
```

This keeps live and replay display behavior deterministic for the same validated event stream.

## Authoritative Facts Rule

Every channel contract carries:

```text
facts_are_authoritative = true
recomputation_allowed = false
```

TUI and formatter code must render the payloads produced by the runtime/sidecar. If a panel needs a value, the producer must emit it as an OBS-01 event payload rather than asking the TUI to calculate it.

## Relationship To OBS-01 / EVT-00 / EVT-01

`OBS-01` defines the event envelope and payload schemas.

`EVT-00` and `EVT-01` validate source market-data canonical time and derived-event causation-chain timestamp inheritance before events reach operator consumers.

`TUI-01` defines how those validated facts are grouped and throttled for operator surfaces.

## Next Consumers

`TUI-02` should use this contract for formatter filters and channel grouping.

`TUI-03` should render from the `TUI` subscriber profile and must display missing/warmup/stale facts as such rather than recomputing or filling values locally.
