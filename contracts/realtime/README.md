# `contracts/realtime` — v2 realtime wire contract (RA-067)

The single interface every v2 realtime component binds to. **Owned by
RA-067.** During the parallel build phase, only RA-063 also writes here
(the alert-config type) — every other agent treats this package as
read-only and frozen.

## Files

| File | Role |
|---|---|
| `events.py` | **Source of truth.** Pydantic v2 envelope + payload families. |
| `events.ts` | Hand-kept TypeScript mirror of `events.py`. |
| `config.py` | Alert-config type. Shape frozen by RA-067; serving filled by RA-063. |
| `config.ts` | TypeScript mirror of `config.py`. |
| `mock_emitter.py` | FastAPI WS server emitting synthetic contract frames. The functional spec for RA-060 and the dev target for RA-061 / RA-062. |
| `tests/test_parity.py` | **Tripwire.** Asserts `events.ts`/`config.ts` match the Pydantic models. A drift reds every worktree. |
| `tests/test_extensibility.py` | RA-050 contract: unknown family round-trips losslessly. |
| `tests/test_mock_emitter.py` | Deterministic generation + a live WS round-trip. |

## The envelope

```
{type, seq, ts_ns, ts_pt, tier, schema_version, payload}
```

- `type` ∈ {snapshot, event, heartbeat, regime, error}
- `seq` monotonic (client gap-detects → REST `/snapshot` resync)
- `tier` ∈ {CRITICAL, HIGH, MEDIUM} | null
- `payload.family` ∈ known families (see `KNOWN_FAMILIES`) **or any string**
  — unknown families round-trip via `GenericPayload` (RA-050 extensibility).

## Rules during the parallel phase

1. **The contract is frozen after RA-067 merges.** If a parallel ticket
   thinks the wire shape must change, it STOPS and escalates — the change
   goes back through this package and re-broadcasts to all agents. No
   local edits to the wire shape.
2. **Edit `events.py` and `events.ts` together.** `test_parity.py` fails
   on drift. Same for `config.py` / `config.ts`.
3. **RA-063 owns `config.py` finalization.** RA-067 only declares the
   shape so RA-061 / RA-062 can bind to it.

## Run

```bash
# from repo root (D:\Quant-futures-app)
python -m pytest contracts/realtime/tests -q          # contract suite
python -m contracts.realtime.mock_emitter             # ws://127.0.0.1:8765/ws
```

## Downstream ownership (created as skeletons by RA-067)

| Path | Ticket |
|---|---|
| `services/realtime_backend/` | RA-060 |
| `services/realtime_backend/config/` | RA-063 |
| `apps/dashboard_ui/` | RA-061 |
| `services/notification_daemon/` | RA-062 |
