# `services/realtime_backend` — RA-060 (skeleton created by RA-067)

**Owned by RA-060.** No other parallel ticket writes here (except RA-063,
which owns the `config/` subdirectory).

## What goes here

Greenfield FastAPI + uvicorn service that:

- imports `rithmic_dashboard.features.*` **as a library** (detectors run
  in-process — not re-reading JSONL),
- tails the live capture siblings (watchdog) and invokes detectors on
  append,
- classifies confluence/tier (CRITICAL/HIGH/MEDIUM), and
- pushes `contracts.realtime` envelopes over a WebSocket endpoint, plus a
  REST `/snapshot` for initial load and post-reconnect resync.

## Binds to the contract

Implements the exact WS surface the RA-067 mock serves
(`contracts/realtime/mock_emitter.py`). The mock is the functional spec —
when this service is up, swapping the UI/daemon from mock → real backend
should require only a URL change.

## Constraints

- < 2GB peak RSS (RA-052 memory contract).
- Detector-as-library parity gate: in-process output must match the
  JSONL-path output on a fixed fixture.
- Read-only: never touch credentials, scheduler entries, env files, or the
  live capture/refresh processes.

See `docs/tickets.md` → RA-060 and `docs/v2_realtime_architecture.md`.
