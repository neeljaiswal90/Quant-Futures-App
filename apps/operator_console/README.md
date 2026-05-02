# Live-Sim Operator Console

Read-only operator console for live-sim journal state.

Current implementation status:

- `server`: foundation, security bootstrap, read-only import guard, JSON-safe contracts, journal ingestion, aggregation, and REST snapshot/history endpoints.
- `web`: React/Vite shell with live snapshot and WebSocket delta hooks. Detailed MVP panels are deferred to `CONSOLE-03-MVP`.

The console must never mutate runtime state, publish journal events, route orders, expose raw journal downloads, or create `JournalEventEnvelope` records.
See the operator start/run documentation in [CONSOLE-05 runbook](../../docs/operator/CONSOLE-05-RUNBOOK.md).

## Scripts

```powershell
npm run console:server -- --journal apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl
npm run console:web
npm run console:test
```

Server defaults to loopback-only behavior. Remote mode requires `OPERATOR_CONSOLE_ALLOW_REMOTE=true`, `OPERATOR_CONSOLE_AUTH_TOKEN`, and `OPERATOR_CONSOLE_ORIGIN_ALLOWLIST`.
Set `QFA_CONSOLE_PORT` to choose the HTTP port. The default is `3217`.

Journal source precedence:

1. `--journal` / `QFA_CONSOLE_JOURNAL`
2. `--journal-dir` / `QFA_CONSOLE_JOURNAL_DIR`, using `rel00_controlled_live_sim_journal*.jsonl` unless `--journal-glob` is provided
3. startup fails clearly

Console checkpoints and malformed-line quarantine are written below `--checkpoint-dir` / `QFA_CONSOLE_CHECKPOINT_DIR`, defaulting to `.operator-console`.

## REST API

The server exposes read-only aggregate endpoints:

- `GET /healthz`
- `GET /snapshot`
- `GET /history?panel=<name>&limit=<n>&range=<iso8601-duration>`
- `WS /stream`

History responses contain panel-level aggregate state only. They do not return raw journal lines, raw event envelopes, or payload dumps. Supported `range` values use ISO-8601 durations such as `PT5M`, `PT1H`, and `P1D`; malformed ranges return `400`. The default history limit is `100`, and requests above `1000` are capped to `1000`.

`/healthz` is an unauthenticated process-liveness endpoint and does not tail or rebuild journal state. Remote `/snapshot` and `/history` requests require bearer auth and an allowed `Origin`; CORS preflight is answered for allowed origins.

`/stream` sends a full snapshot on connect, then sequence-aware aggregate deltas. High-rate telemetry deltas are coalesced at `250ms` by default; override with `--ws-coalesce-ms` or `QFA_CONSOLE_WS_COALESCE_MS`. Remote WebSocket upgrades require the same bearer token and allowed `Origin` as remote REST state endpoints.

## Web Shell

The Vite app defaults API calls to its own origin. During local development against the loopback server, set `VITE_OPERATOR_CONSOLE_API_BASE=http://127.0.0.1:3217` and optionally `VITE_OPERATOR_CONSOLE_WS_URL=ws://127.0.0.1:3217/stream`.
