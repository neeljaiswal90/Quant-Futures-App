# `services/notification_daemon` — RA-062

**Owned by RA-062.** A headless Python daemon — a second WebSocket client on
the RA-067 mock / RA-060 realtime stream — that fires **native Windows
toasts on CRITICAL alerts**. Solves "browser was backgrounded, missed the
alert."

It binds to the frozen realtime contract (`contracts.realtime`) and develops
entirely against the RA-067 mock emitter — zero dependency on RA-060 landing.

## What it does

1. Connects to the WS stream (`ws://127.0.0.1:8765/ws` by default) and parses
   every frame into a `RealtimeMessage`.
2. Maintains an in-memory `{zone_id: price}` map from `snapshot` and
   `zone_update` frames (the CRITICAL `signal` family carries only a
   `level_id`, not a price).
3. For each frame, runs the pure **gate** (`should_notify`) — fires a toast
   iff `tier == "CRITICAL"` **and** the tier is enabled **and** its
   `windows_toast` flag is set **and** we are not in quiet hours.
4. Renders a `(title, body)` toast: `CRITICAL - <level> @ <price>` /
   `<families>` / `<posture>`.
5. On any disconnect, reconnects with exponential backoff + full jitter
   (base 0.5s, ×2, cap 30s), retrying forever.

## Module map

| Module | Responsibility |
| --- | --- |
| `gate.py` | Pure `should_notify(msg, config, now_pt)` + `in_quiet_hours` |
| `render.py` | Pure `render_toast(msg, zone_prices)` + `ZonePriceMap` |
| `notifier.py` | `Notifier` protocol, `WindowsToastNotifier` (lazy), `FakeNotifier` |
| `ws_client.py` | `RealtimeClient` reconnect loop + `backoff_delays` generator |
| `config_loader.py` | Read-only `AlertConfig` load (file → defaults) |
| `run.py` | Daemon wiring, CLI, lifecycle, structured logging |

The toast backend (`windows-toasts`) is **lazy-imported only when
`WindowsToastNotifier` is constructed**, so importing this package never
fails on a box without it. Tests inject `FakeNotifier` and exercise the whole
pipeline with zero toast backend.

## Run it

The package lives at `services/notification_daemon`, so launch from
`services/` (puts the package on the path; the contract repo root is added
automatically at import):

```powershell
cd D:\Quant-futures-app\services
python -m notification_daemon.run                       # ws://127.0.0.1:8765/ws
python -m notification_daemon.run --url ws://host:9000/ws
python -m notification_daemon.run --no-toast            # log-only (no backend)
python -m notification_daemon.run --log-level DEBUG
python -m notification_daemon.run --tray                # DEFERRED — see below
```

Config is read (never written) from
`data/dashboard/alert_config.json` if present, else the shipped defaults from
`contracts.realtime.config.default_alert_config()`.

### Quiet hours interpretation

The shared `QuietHoursConfig` is `audio_only=True` — it silences *audio*
while keeping visual banners in the browser UI. **This daemon has no audio
channel; its only output is a visual toast.** Honoring `audio_only` literally
would make quiet hours a no-op here, defeating the user's intent ("be quiet
at night"). So when quiet hours is enabled, the daemon **fully suppresses the
toast** during the window (wrap-around `22:00→06:00` handled). "Now" is
computed in `America/Los_Angeles` via `contracts.realtime.events.PT`.

### Tray icon (`--tray`) — DEFERRED

`--tray` is accepted but tray support is deferred: `pystray` is not installed.
Passing the flag logs a notice and runs the core daemon unchanged.

## Develop / verify

```powershell
# Tests (~12, no pytest-asyncio needed; async driven via asyncio.run):
cd D:\Quant-futures-app\services\notification_daemon
python -m pytest -q

# Lint:
cd D:\Quant-futures-app\services\notification_daemon
ruff check .

# Types (run from repo root; mypy_path makes both roots resolvable):
cd D:\Quant-futures-app
mypy --config-file services\notification_daemon\pyproject.toml services\notification_daemon
```

Live round-trip + e2e tests start the RA-067 mock in a uvicorn thread; they
`importorskip`/skip gracefully if the infra can't start.

## Install as a Windows startup task (INSTRUCTIONAL ONLY)

> RA-062 does **not** create or modify any scheduler entry. The steps below
> are documentation for an operator to run manually. Adjust paths to your
> checkout and Python interpreter.

The daemon is a long-running background process; the natural way to keep it
alive across logon is a **Task Scheduler** task that runs at logon.

### Option A — Task Scheduler GUI

1. Open **Task Scheduler** → **Create Task** (not "Basic Task").
2. **General**: name `MNQ Notification Daemon`; "Run only when user is logged
   on" (toasts require an interactive session — do **not** run as SYSTEM, it
   cannot display toasts).
3. **Triggers**: New → "At log on" (optionally a 15s delay).
4. **Actions**: New → "Start a program":
   - Program/script: full path to `python.exe` (or `pythonw.exe` for no
     console window), e.g. `C:\Users\<you>\AppData\Local\Programs\Python\Python312\pythonw.exe`
   - Add arguments: `-m notification_daemon.run --url ws://127.0.0.1:8765/ws`
   - Start in: `D:\Quant-futures-app\services`
5. **Settings**: uncheck "Stop the task if it runs longer than…" (it is a
   daemon); set "If the task is already running: Do not start a new instance".
6. Save.

### Option B — `schtasks` (review before running; do not run blindly)

```powershell
# EXAMPLE ONLY — adjust the python path and checkout path first.
schtasks /Create /TN "MNQ Notification Daemon" /SC ONLOGON /RL LIMITED `
  /TR "'C:\Path\To\pythonw.exe' -m notification_daemon.run" /F
# Task Scheduler has no native "Start in" for /Create; if `contracts` does not
# resolve, wrap the command in a one-line launcher that cd's to
# D:\Quant-futures-app\services first, or set PYTHONPATH=D:\Quant-futures-app\services.
```

### Verify the task

- Toast on the next CRITICAL (or temporarily point `--url` at the mock and run
  `python -m contracts.realtime.mock_emitter`).
- Logs go to **stderr**; redirect to a file in the action arguments if you
  want a persistent log, e.g. append
  `1>> %LOCALAPPDATA%\mnq_daemon.log 2>>&1` via a `.cmd` wrapper.

To remove: Task Scheduler → delete the task, or
`schtasks /Delete /TN "MNQ Notification Daemon" /F`.

See `docs/tickets.md` → RA-062.
