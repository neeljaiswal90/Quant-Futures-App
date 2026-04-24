# TUI-04: Journal Query CLI

`TUI-04` adds a read-only journal query CLI for operator and launch-gate provenance checks.

It reads OBS-01 JSONL, validates event schemas, and renders already-journaled facts. It does not run strategies, recompute indicators, open sockets, mutate state, route orders, or talk to live execution.

## Command

```powershell
npm run journal:query -- --journal apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl --candidate candidate-obs00-1
```

Directory mode reads all `*.jsonl` files in deterministic filename order:

```powershell
npm run journal:query -- --journal-dir journals/session-2026-04-23 --position position-obs00-1
```

## Selectors

- `--candidate <candidate_id>`: reconstruct candidate provenance.
- `--position <position_id>`: show fills, position transitions, and management facts.
- `--event <event_id>`: show the event, its direct cause, and direct children.
- `--causation <causation_id>`: show the cause event and events directly caused by that id.

If a requested id is missing, the command exits non-zero and prints:

```text
missing in journal id=<id> reason=<reason>
```

## Filters

- `--strategy <strategy_id>`
- `--session <session_id>`
- `--run <run_id>`
- `--type <event_type>`
- `--since-ts-ns <timestamp>`
- `--until-ts-ns <timestamp>`
- `--limit <n>`

Without a selector, filters return matching events in input order.

## Output

Text is the default:

```powershell
npm run journal:query -- --journal apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl --event candidate-1
```

JSON output is deterministic and preserves nanosecond timestamps as decimal strings:

```powershell
npm run journal:query -- --journal apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl --event candidate-1 --format json
```

Supported formats:

- `--format text`
- `--format json`

## Malformed Lines

Malformed JSONL or OBS-01 schema-invalid lines are reported to stderr and skipped by default so operators can inspect partial journals:

```text
session.jsonl:42: journal event schema validation failed: ...
```

Use `--strict` to make any malformed line produce exit code `1`.

## Provenance Rules

Candidate queries include:

- upstream causation ancestors, such as feature/structure and strategy evaluation events;
- the candidate itself;
- downstream caused events, such as risk gate, sizing, order intent, simulated fill, position, and management events;
- related feature/strategy/rank facts when present in the journal.

Position queries include matching position and management events plus their causation ancestors, including fills where present.

The CLI never infers missing events. If an event references a missing `causation_id`, the output records `missing in journal` with the missing id.

## REL-01 Traceability

`TUI-04` supports REL-01 traceability spot-checks by making the chain

```text
feature snapshot -> strategy eval -> candidate -> risk gate -> sizing -> fill -> position lifecycle
```

queryable from committed or live/replay journal files.

