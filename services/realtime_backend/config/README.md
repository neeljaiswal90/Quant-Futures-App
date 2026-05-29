# `services/realtime_backend/config` — RA-063 alert-configuration system

**Owned by RA-063.** Persistence + REST serving + tier-gating for the alert
preferences. The config **type** is frozen in `contracts/realtime/config.py`
(`AlertConfig`, declared by RA-067); this package does *not* extend it — the
shipped shape already covers every requirement. `config.ts` and the
`tests/test_parity.py` tripwire are therefore untouched.

Imported at runtime as `realtime_backend.config` (with `services/` on
`sys.path`; the parent package bootstraps the repo root for `contracts.*`).

## Layout

| File | Purpose |
| --- | --- |
| `store.py` | `AlertConfigStore` — load-or-seed, in-memory cache, atomic write-through. |
| `gating.py` | `should_fire(...)` — pure tier-gating decision. |
| `router.py` | `create_config_router(store)` — mountable FastAPI `APIRouter`. |
| `tests/` | store round-trip + atomic-write, gating truth-table, router handlers. |

## Persisted document

Single JSON document, default path (repo-root relative):

```
data/dashboard/alert_config.json
```

`data/dashboard/` does **not** exist yet; the first write creates it
(`mkdir(parents=True)`). Construction never writes — a missing file seeds the
in-memory cache from `default_alert_config()` and the file is materialized on
the first `PUT`. The path is injectable (`AlertConfigStore(path=...)`) for tests.

Writes are atomic: a uniquely-named temp file in the same directory is fsync'd
then `os.replace`d into place, so a reader never sees a half-written file and a
crash mid-write cannot corrupt the live document.

## REST endpoint contract

Mounted by RA-060 (see seam below). Routes:

| Method | Path | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/config/alerts` | — | `AlertConfig` JSON | current config (defaults if never written) |
| `PUT` | `/api/config/alerts` | full `AlertConfig` JSON | persisted `AlertConfig` JSON | full-document **replace**, not a patch |

`PUT` is validated against `AlertConfig` before the handler runs. The contract's
`extra="forbid"` means an **unknown key returns `422`** (intended — PUT replaces
the whole document); a wrong-typed or missing field is likewise `422`, and the
store is not touched on a rejected write.

## RA-060 integration seam (RA-068 convergence wiring)

RA-060 owns `app.py` and mounts this router with **one line**. RA-063 does not
edit RA-060's files. Construct a single shared store so the REST cache and the
gating path read the *same* `AlertConfig` object:

```python
# in RA-060's create_app(), after `app = FastAPI(...)`:
from realtime_backend.config.store import AlertConfigStore
from realtime_backend.config.router import create_config_router

config_store = AlertConfigStore()          # default data/dashboard/alert_config.json
app.state.config_store = config_store       # hand to the gating path too
app.include_router(create_config_router(config_store))
```

(For a quick standalone mount, `from realtime_backend.config.router import router`
exposes a default router backed by a process-wide store at the default path —
but prefer the shared-store form above so gating and REST agree.)

## Tier-gating

```python
from realtime_backend.config.gating import should_fire, AlertDisposition

def should_fire(
    config: AlertConfig,     # the store's cached object (read every event)
    tier: str,               # "critical" | "high" | "medium"
    distance_pt: float,      # price distance from the level, in points (magnitude)
    now_pt: datetime,        # current wall-clock; normalized to America/Los_Angeles
) -> AlertDisposition: ...
```

`AlertDisposition` is a frozen dataclass:
`fire: bool`, `audio: bool`, `browser_notif: bool`, `windows_toast: bool`,
`reason: str`. Each per-channel flag is already gated — dispatch a channel iff
its flag is `True`.

Decision pipeline (short-circuits in order):

1. **tier-enabled** — `config.<tier>.enabled` is the master switch.
2. **proximity-armed** — `abs(distance_pt) <= config.proximity.<tier>_pt`.
3. **quiet-hours** — if `config.quiet_hours.enabled` and `now_pt` falls inside
   the window (`start_pt`..`end_pt`, half-open, midnight-wrapping when
   `start > end`):
   - `audio_only=True`  → suppress audio, keep visual banners;
   - `audio_only=False` → suppress the whole tier.

The function is pure (no I/O, no clock read — `now_pt` is injected), so the
truth table is deterministic and unit-tested per tier × in/out proximity ×
quiet on/off.

## Hot-reload

In-memory cache + write-through — **not** an mtime poller. A `PUT` mutates the
shared cached `AlertConfig` and persists it; the gating path reads that same
object on the next event, so a change takes effect with no restart. An explicit
`store.reload_from_disk()` is provided for out-of-band file edits.

## Tooling (self-contained; run from `services/`)

```
# tests
cd services/realtime_backend/config && python -m pytest tests/ -q

# lint
cd services/realtime_backend/config && python -m ruff check .

# types — run from services/ so the package resolves as realtime_backend.config
cd services && python -m mypy --config-file realtime_backend/config/pyproject.toml \
  realtime_backend/config/__init__.py realtime_backend/config/store.py \
  realtime_backend/config/gating.py realtime_backend/config/router.py \
  realtime_backend/config/conftest.py realtime_backend/config/tests/
```

See `docs/tickets.md` → RA-063.
