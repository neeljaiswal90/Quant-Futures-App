# Live-Sim Operator Console

Read-only operator console for live-sim journal state.

Current implementation status:

- `server`: foundation, security bootstrap, read-only import guard, and JSON-safe contracts.
- `web`: package scaffold only. React/Vite UI work is deferred to the web MVP tickets.

The console must never mutate runtime state, publish journal events, route orders, expose raw journal downloads, or create `JournalEventEnvelope` records.

## Scripts

```powershell
npm run console:server -- --journal apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl
npm run console:web
npm run console:test
```

Server defaults to loopback-only behavior. Remote mode requires `OPERATOR_CONSOLE_ALLOW_REMOTE=true`, `OPERATOR_CONSOLE_AUTH_TOKEN`, and `OPERATOR_CONSOLE_ORIGIN_ALLOWLIST`.

Journal source precedence:

1. `--journal` / `QFA_CONSOLE_JOURNAL`
2. `--journal-dir` / `QFA_CONSOLE_JOURNAL_DIR`, using `rel00_controlled_live_sim_journal*.jsonl` unless `--journal-glob` is provided
3. startup fails clearly

Console checkpoints and malformed-line quarantine are written below `--checkpoint-dir` / `QFA_CONSOLE_CHECKPOINT_DIR`, defaulting to `.operator-console`.
