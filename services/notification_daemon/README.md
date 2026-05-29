# `services/notification_daemon` — RA-062 (skeleton created by RA-067)

**Owned by RA-062.** No other parallel ticket writes here.

## What goes here

A headless Python daemon — a second WebSocket client on the RA-067 mock /
RA-060 stream — that fires native Windows toasts on CRITICAL alerts. Solves
"browser backgrounded, missed the alert."

- `windows-toasts` / `win11toast` (modern, supports actions).
- WS client with reconnect-with-backoff.
- CRITICAL-only by default (honors `contracts/realtime/config.py`).
- Toast = zone price + signal families + 1-line posture.
- Optional tray icon (regime + connection status).

## Binds to the contract

Consumes `contracts.realtime` envelopes. Develops entirely against the
RA-067 mock emitter — zero dependency on RA-060 landing.

See `docs/tickets.md` → RA-062.
