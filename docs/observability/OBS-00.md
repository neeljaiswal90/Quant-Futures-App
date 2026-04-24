# OBS-00: Mini-Journal Fixture

`OBS-00` adds a committed mini-journal fixture for formatter, operator-surface, transport, and replay smoke tests before the full runner loop exists.

## Files

```text
apps/strategy_runtime/tests/fixtures/obs00/
  mini-journal.jsonl
  manifest.json
```

The fixture is intentionally small: 24 JSONL events.

## Provenance

The April 23, 2026 Rithmic soak proved the required market-data streams and session states, but raw vendor captures are not committed to the repo.

This fixture is a synthetic OBS-01 projection of representative soak/session states:

- startup config and connection;
- warmup feed state;
- RTH session state;
- roll and halt advisory examples;
- quote, trade, bar close, and microstructure source events;
- feature, structure, strategy, candidate, risk, sizing, order intent, simulated fill, position, and management lifecycle events;
- gap and book-rebuild examples;
- active feed state after rebuild.

No credentials, account identifiers, Rithmic packets, Databento records, or proprietary raw captures are included.

## Downsampling Rules

The fixture keeps one representative event per required state rather than a time-series sample.

Rules:

- Preserve OBS-01 schema version `1`.
- Preserve ADR-0001 canonical timestamp semantics.
- Preserve EVT-00 source market-data rule: `event.ts_ns === payload.exchange_event_ts_ns`.
- Preserve EVT-01 derived-event causation-chain rule: derived events inherit `ts_ns` from the buffered cause event.
- Preserve deterministic event order.
- Use synthetic IDs and payload values only.

The manifest records event count, normalized-LF SHA-256 checksum, event-type coverage, and redaction statement.

## Usage

Formatter smoke:

```powershell
Get-Content -Raw apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl |
  node node_modules/tsx/dist/cli.cjs apps/strategy_runtime/src/operator/formatter.ts --only type=CANDIDATE,POSITION,SIM_FILL
```

Full validation:

```powershell
npm test -- apps/strategy_runtime/tests/unit/obs00-fixture.test.ts
```

## Downstream Consumers

`TUI-02` uses the fixture for formatter parity smoke.

`TUI-03` should use the fixture first for empty/warm/active panel states before live-runner validation.

`OBS-03` should use the fixture as an early byte-stability baseline before full replay parity exists.
