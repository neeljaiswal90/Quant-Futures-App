# `services/realtime_backend/config` — RA-063 (skeleton created by RA-067)

**Owned by RA-063.** Carved out as a distinct subdirectory so RA-063 can
run in parallel with RA-060 (which owns the rest of
`services/realtime_backend/`) without a write collision.

## What goes here

Persistence + REST serving + hot-reload for the alert configuration:

- reads/writes `data/dashboard/alert_config.json`,
- serves REST get/put,
- hot-reloads into the backend's tier-gating without a restart,
- enforces quiet-hours (silence audio, keep visual banners).

## Binds to the contract

The config **type** lives in `contracts/realtime/config.py` (declared as a
stub by RA-067). RA-063 finalizes serving/persistence and may extend the
type — additively, through the contract, keeping `config.ts` in sync
(the parity test enforces this).

See `docs/tickets.md` → RA-063.
