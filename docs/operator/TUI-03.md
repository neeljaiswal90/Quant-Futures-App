# TUI-03: Read-Only Operator Dashboard

`TUI-03` adds the first V1 operator dashboard. It is intentionally a read-only terminal renderer over OBS-01 journal/event facts.

The dashboard does not implement the runner, sockets, order entry, flatten controls, config mutation, or live execution. It renders the same authoritative facts consumed by the formatter and transport.

## Command

Fixture smoke:

```powershell
npm run tui:fixture -- --no-color
```

Journal file:

```powershell
npm run tui -- --journal path/to/journal.jsonl
```

Pipe from stdin:

```powershell
Get-Content -Raw path/to/journal.jsonl | npm run tui -- --no-color
```

Options:

- `--fixture obs00`: render the committed OBS-00 fixture.
- `--journal <path>`: render a JSONL journal file.
- `--at <ts_ns>` / `--render-at <ts_ns>`: render stale state relative to an explicit event timestamp.
- `--color`: enable ANSI color. Color is on by default.
- `--no-color`: disable ANSI for byte-stable fixture smoke output.

If neither `--fixture` nor `--journal` is provided, the TUI reads JSONL from stdin.

Invalid JSONL or OBS-01 schema failures are strict, matching `TUI-02`: valid events still render, diagnostics go to stderr, and the process exits `1`.

## Panels

The renderer emits one single-screen snapshot with eight panels:

- `CONNECTION`: connection, feed, latency placeholders, gap count, and book-rebuild facts.
- `SESSION`: session phase, roll advisory, halt, maintenance placeholder, and close placeholder.
- `MARKET`: latest L1 quote, trade print, and bar recap.
- `INDICATORS`: emitted feature values such as EMA, ATR, sigma, and VWAP z-score.
- `STRUCTURE`: emitted structure facts such as trend, BOS, pullback, and swing context.
- `MICROSTRUCTURE`: emitted sidecar microstructure values such as spread, OFI, and queue imbalance.
- `STRATEGY_GATES`: strategy evaluation, candidate, risk gate, and sizing facts.
- `POSITION`: order intent, simulated fill, position, management tick, and management action facts.

The default TUI subscription uses the TUI-01 channels:

```text
CONNECTION, SESSION, MARKET, INDICATORS, STRUCTURE, MICROSTRUCTURE,
STRATEGY_GATES, CANDIDATES, ORDERS, POSITION
```

It excludes `QUOTE_RAW` and `CONFIG`.

The `STRATEGY_GATES` panel intentionally also subscribes to `CANDIDATES` so it can show candidate, risk, and sizing facts beside the strategy gate. The `POSITION` panel intentionally also subscribes to `ORDERS` so fills can be audited next to position state.

## Color And State Rules

Color is on by default in the TUI:

- green: active/pass/armed/open/positive facts;
- yellow: warmup/wait/proposed/roll-block facts;
- red: blocked/reject/halt/gap/negative facts;
- dim: missing or stale panels.

`--no-color` is available for deterministic fixture and CI smoke tests.

Panel freshness uses `event.ts_ns`, not wall-clock time. Each panel has a channel-specific `T_stale`; when the latest relevant event is older than that threshold relative to `--at` or the max event timestamp in the input, the panel renders `status=STALE` and dims its data.

Missing panels render `status=MISSING` with `--` placeholders. Warmup states render `status=WARMUP` instead of silently presenting stale facts as live.

## Determinism

The TUI renderer:

- parses OBS-01 JSONL and validates schemas before rendering;
- uses nanosecond event timestamps as decimal strings;
- never calls wall-clock APIs to determine freshness;
- never recomputes indicators, structure, gates, risk, sizing, fills, positions, or management state;
- renders in deterministic panel order.

## Relationship To OBS-00

Initial development is fixture-backed:

```text
apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl
```

The OBS-00 fixture exercises empty, warmup, active, gap, book-rebuild, strategy, fill, position, and management states without requiring Rithmic, Databento, or the runner loop.

Live-runner validation remains part of `REL-00`.
