# TUI-02: Structured Log Formatter

`TUI-02` adds a deterministic formatter for validated OBS-01 journal/event JSONL.

The formatter is intentionally read-only. It renders event facts and does not recompute indicators, structure, strategy gates, risk decisions, sizing, fills, position state, or management actions.

## Command

```powershell
cat journal.jsonl | npm run format:journal -- --only type=CANDIDATE,POSITION,SIM_FILL
```

The script entry is:

```text
format:journal = tsx apps/strategy_runtime/src/operator/formatter.ts
```

It reads JSONL from stdin and writes human-readable text to stdout. Diagnostics for invalid JSONL or schema failures go to stderr and produce exit code `1`.

Exit-code behavior is strict in V1:

- `0`: every non-empty input line parsed and validated;
- `1`: at least one non-empty line failed JSON parsing or OBS-01 schema validation.

This makes the formatter suitable for CI and replay parity checks. Ad-hoc tailing workflows should expect stderr diagnostics if a producer writes incomplete or malformed lines.

## Determinism Rules

- Output uses `event.ts_ns` as a decimal nanosecond string.
- No local timezone or wall-clock formatting is used.
- No ANSI color is emitted unless `--color` is explicitly provided.
- Events render in input order.
- Payload summaries use deterministic key ordering where generic key lists are needed.

## Filters

Supported filters:

- `--only type=A,B` or `--only A,B`: include only event types.
- `--grep text`: substring match against event ids, causation/correlation ids, run/session ids, type, and canonical payload JSON.
- `--strategy strategy_id`: include events whose payload has that `strategy_id`.
- `--since ts_ns`: include events where `event.ts_ns >= ts_ns`.
- `--color`: opt into ANSI color.

`--since` accepts only decimal nanosecond timestamps. ISO strings are display-only and are not part of canonical replay formatting.

`--grep` searches the canonical payload JSON after timestamp revival, so timestamp values are searched as decimal nanosecond strings.

Feature-like payloads (`FEATURES`, `STRUCTURE`, `MICROSTRUCTURE`) render their value keys, not the full value map, to keep operator lines compact. Use the raw JSONL with `jq` or a future journal-query command when exact feature values are needed.

Numeric fields render as producer-emitted JavaScript numbers. Producers are responsible for canonical numeric precision if a field participates in byte-identical replay comparisons.

## Relationship To TUI-01

The formatter uses TUI-01 channel grouping. For example, `QUOTE` renders on `MARKET` by default; `QUOTE_RAW` remains an explicit diagnostic/replay channel and is not the default formatter line label.

## Relationship To OBS-01

The formatter parses JSONL with APP-02 timestamp revival and validates events with the OBS-01 schema before rendering.

Invalid events are not rendered. They are reported with stable line-number diagnostics.

JSONL means one complete event object per line. Pretty-printed multi-line JSON is invalid input for the formatter.

## OBS-00 Fixture Note

`TUI-02` is ready for the `OBS-00` fixture smoke once that fixture lands. Current tests use synthetic OBS-01 events so the formatter can be validated before the soak-derived mini-journal is committed.
