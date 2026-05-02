# CONSOLE-05 Runbook

This runbook captures safe startup, configuration, and runtime checks for the live-sim Operator Console.

## 1) What this runbook covers

The Operator Console is read-only. It renders read-only aggregates and event deltas from a runtime JSONL journal.

Supported interfaces:

- `GET /healthz`
- `GET /snapshot`
- `GET /history?panel=...`
- `WS /stream`

The web shell is in `apps/operator_console/web` and is optional for operators; REST endpoints are always available with the server.

## 2) Loopback mode (recommended default)

Loopback mode is safest for a local workstation and requires no remote auth.

1. Start from repo root:

```powershell
cd C:\Quant-futures-app
npm run console:server -- --journal-dir .\reports\rel --journal-glob rel00_controlled_live_sim_journal*.jsonl
```

2. From another terminal, start the web shell against loopback:

```powershell
cd C:\Quant-futures-app
$env:VITE_OPERATOR_CONSOLE_API_BASE = 'http://127.0.0.1:3217'
npm run console:web
```

3. Verify:

```powershell
curl http://127.0.0.1:3217/healthz
curl http://127.0.0.1:3217/snapshot
```

## 3) Remote mode

Remote mode binds non-loopback and requires strict operator credentials.

1. Export:

```powershell
$env:QFA_CONSOLE_BIND = '0.0.0.0'
$env:OPERATOR_CONSOLE_ALLOW_REMOTE = 'true'
$env:OPERATOR_CONSOLE_AUTH_TOKEN = '<choose-a-strong-token>'
$env:OPERATOR_CONSOLE_ORIGIN_ALLOWLIST = 'https://ops.example'
```

2. Start the server:

```powershell
npm run console:server -- --journal-dir .\reports\rel
```

3. Validate auth + origin:

```powershell
curl -i http://<host>:3217/healthz
curl -i -H "Authorization: Bearer <token>" `
  -H "Origin: https://ops.example" `
  http://<host>:3217/snapshot
```

4. Configure web shell for remote endpoint:

```powershell
$env:VITE_OPERATOR_CONSOLE_API_BASE = 'https://ops.example/api'
$env:VITE_OPERATOR_CONSOLE_WS_URL = 'wss://ops.example/stream'
npm run console:web
```

## 4) CLI flags and env variables

- Journal source (required):
  - `--journal <path>` or `QFA_CONSOLE_JOURNAL=<path>`
  - `--journal-dir <dir>` or `QFA_CONSOLE_JOURNAL_DIR=<dir>`
  - `--journal-glob <glob>`
- Checkpointing:
  - `--checkpoint-dir <dir>` or `QFA_CONSOLE_CHECKPOINT_DIR=<dir>`
  - default: `.operator-console`
  - snapshot cache: `<checkpoint-dir>/checkpoints/console-snapshot.json`
  - malformed-line quarantine: `<checkpoint-dir>/checkpoints/quarantined-lines.jsonl`
- Runtime behavior:
  - `--mode live|replay` or `QFA_CONSOLE_MODE`
  - `--poll-ms <n>` or `QFA_CONSOLE_POLL_MS`
  - `--ws-coalesce-ms <n>` or `QFA_CONSOLE_WS_COALESCE_MS`
- Porting:
  - `QFA_CONSOLE_BIND` (default `127.0.0.1`)
  - `QFA_CONSOLE_PORT` (default `3217`)

## 5) Validation checklist

Run these checks during rollout and after incidents:

- `/healthz` responds `200` and does not refresh journal state.
- `/snapshot` returns `schema_version`, `generated_from.event_count`, and expected panel snapshots.
- `/history` accepts ISO-8601 durations (`PT5M`, `PT1H`, `P1D`) and rejects malformed ranges.
- Optional 600k+ fixture stress check:

```powershell
$env:OPERATOR_CONSOLE_VERIFY_600K_FIXTURE = "C:\path\to\large-journal.jsonl"
npm run console:test
```

## 6) Known operational caveats

- **TLS/transport security (remote):** remote mode must sit behind a loopback-restricted host or TLS-terminating proxy. Remote bearer auth is required and token rotation is restart-required.
- **Restart safety:** console restores snapshot state from checkpoint cache and journal checkpoints on restart; this is intended to prevent reprocessing from offset 0.
- **Embedded feature-mask restore:** when `mask_source=embedded`, the restored snapshot rebuilds mask metadata from snapshot fields and static embedded defaults. This is sufficient for current policy posture, but if a future mask version adds semantic shape changes, prefer a full native embedded-mask snapshot migration or add a migration note.
- **Counter continuity:** feature-policy and missing-terminal-order counters are reconstructed from capped history at restore and may not be strictly monotonic across restart.

## 7) Known bad states

- If restart requires remote token rotation, the token must be replaced and the console restarted; hot token swap is not supported.
- For `403` on `Origin`:
  - `Origin` is not allowed in local loopback mode unless loopback.
  - remote mode requires exact match in `OPERATOR_CONSOLE_ORIGIN_ALLOWLIST` (comma-delimited list).
- For repeated dropped WS frames: check client count and network health; snapshots are replayed on connect.

