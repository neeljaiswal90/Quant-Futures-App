# v2 Realtime Dashboard — Architecture & Parallel-Execution Plan

Stack locked 2026-05-28. This doc is the authoritative reference for the v2
realtime build. It supersedes the HTMX/SSE assumptions in
`engineer_onboarding_v2_dashboard.md` (kept for pipeline/operational
context only — ignore its frontend-stack section).

---

## 1. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Frontend | **React 18 + TypeScript** (Vite) | Largest ecosystem, safest handoff, mature realtime/chart libs. |
| Chart | **TradingView lightweight-charts v5.2** (`lightweight-charts`, Apache-2.0) | Purpose-built financial canvas chart; native price lines, markers, panes, per-tick `update()`. |
| Transport | **WebSocket** | Bidirectional, lowest latency, lets the UI send acks / config / alert-dismissals. |
| Backend | **FastAPI + uvicorn**, detectors imported **as a library** | Stays in Python so it imports `rithmic_dashboard.features.*` in-process — tighter latency than re-reading JSONL. |
| Scope | **Greenfield view + serving layer; retain the signal pipeline** | v1 HTML view is retired. RA-046–RA-059 detectors are reused as a library, not rewritten. |

What is **retained**: the entire detection pipeline (σ bands, EWMA regime,
iceberg RA-059, aggressor RA-058, absorption, sweep, VPOC/VAH/VAL, zones).
What is **retired**: the v1 HTML dashboard generator and its 5-min refresh
view. The realtime backend calls the detectors directly.

RA-071 retires only the V1 HTML view. The normalization pipeline is retained:
until the operator performs the RA-070 cutover, `run_local_probe_refresh.ps1`
continues to own incremental normalize and `daily_zones`. After cutover, the
backend self-normalizer owns the same normalized siblings. Exactly one
normalizer should run at a time.

---

## 2. Architecture

```
            ┌──────────────────────── Rithmic capture (unchanged) ────────────────────────┐
            │  probe → raw JSONL → normalize → OBS-01 → *.mbo/.mbp1/.obs01 siblings        │
            └───────────────────────────────────┬─────────────────────────────────────────┘
                                                 │ tail (watchdog)
                                                 ▼
   ┌─────────────────────────── services/realtime_backend (FastAPI) ───────────────────────┐
   │  imports rithmic_dashboard.features.* as a library                                     │
   │  detectors run in-process on the tail → confluence/tier classifier                     │
   │  ┌───────────────┐   ┌───────────────────┐   ┌──────────────────────────────────────┐ │
   │  │ WS endpoint   │   │ REST /snapshot     │   │ heartbeat + staleness emitter        │ │
   │  │ (push events) │   │ (load + resync)    │   │ seq counter (gap → client resync)    │ │
   │  └──────┬────────┘   └─────────┬──────────┘   └──────────────────────────────────────┘ │
   └─────────┼──────────────────────┼───────────────────────────────────────────────────────┘
             │  contracts/realtime (Pydantic ⇄ TypeScript, parity-tested)                    
   ┌─────────▼──────────┐                          ┌─────────▼────────────────────────────┐
   │ apps/dashboard_ui  │                          │ services/notification_daemon          │
   │ React + TS + Vite  │                          │ 2nd WS client → Windows toast         │
   │ lightweight-charts │                          │ CRITICAL-only (RA-063 config)         │
   │ 5-tier layout      │                          └───────────────────────────────────────┘
   └────────────────────┘
```

The `contracts/realtime` package is the single interface everything binds
to. It ships a **mock emitter** so the UI and daemon build against a fake
backend before RA-060 exists.

---

## 3. lightweight-charts evaluation (v5.2.0, fetched 2026-05-28)

Verdict: **use it.** It maps cleanly onto every chart element this
dashboard needs.

| Dashboard need | lightweight-charts feature |
|---|---|
| MNQ price | `chart.addSeries(CandlestickSeries, {...})` — v5 API |
| ±1σ/±2σ bands, VPOC/VAH/VAL, zones, W-VWAP | `series.createPriceLine({price, color, lineStyle, title})` |
| iceberg / absorption / sweep / CRITICAL markers | `createSeriesMarkers` primitive (v5) |
| volume + CVD subchart | second **pane** (v5 native multi-pane) |
| per-tick live update | `series.update(bar)` — **not** `setData()` |
| initial load / reconnect resync | `series.setData(bars)` once |
| 0.25 tick formatting | custom price-scale formatter |

Notes:
- **No official React component** — use the documented `useRef` +
  `useEffect` lifecycle (create in effect, `chart.remove()` on cleanup).
  Do not adopt a community wrapper; the raw pattern is ~30 lines and
  avoids a dependency.
- **`update()` vs `setData()` is load-bearing**: `setData` replaces the
  whole series and full-redraws (kills perf on a tick stream). The WS
  `price_tick` family routes to `update()`; only snapshot/resync uses
  `setData`.
- License Apache-2.0 with a TradingView attribution requirement — keep
  the attribution link in the UI footer.

---

## 4. Parallelization — contract-first fan-out

The only thing blocking parallelism is the shared interface. RA-067
defines + freezes it and ships a mock, after which four tickets build
concurrently against disjoint directories.

```
DATA TRACK (independent — start immediately, no contract dep):
  RA-065 (priority iceberg) ──► RA-066 (tolerance calibration)

REALTIME TRACK:
  RA-067 (contract + mock + skeleton)   ◄── SERIAL, blocks the fan-out
        │
        ├──► RA-060  WebSocket backend (real emitter, detectors-as-lib)
        ├──► RA-061  React + lightweight-charts UI  (builds vs mock)
        ├──► RA-062  Windows notification daemon     (builds vs mock)
        └──► RA-063  alert config (schema + serving)
                          │
                          ▼
                    RA-068  integration + production hardening (convergence)
```

Wall-clock: RA-067 (½ day) → widest parallel leg RA-061 (~2 days) →
RA-068 (½ day). The data track (RA-065→066) runs entirely alongside.

### File-ownership map (no two parallel tickets write the same path)

| Ticket | Owns (writes only here) |
|---|---|
| RA-067 | `contracts/realtime/` + creates the skeleton dirs |
| RA-060 | `services/realtime_backend/` |
| RA-061 | `apps/dashboard_ui/` |
| RA-062 | `services/notification_daemon/` |
| RA-063 | `services/realtime_backend/config/` + the config type in `contracts/realtime/` |
| RA-068 | integration seams + `run_realtime_stack.ps1` + `docs/operations.md` (runs alone) |
| RA-065 | `rithmic_analytics/ops/normalize_probe.py`, `rithmic_dashboard/.../models.py`, `mbo_order_tracker.py` |
| RA-066 | `rithmic_analytics/scripts/calibrate_iceberg_tolerance.py` (+ docs) |

RA-063 touches `contracts/realtime/` (the config type) — coordinate with
RA-067's output: the config type is **declared** by RA-067 as a stub and
**filled in** by RA-063. No simultaneous write if RA-067 lands first.

### Concurrency safety

- Each parallel agent runs in its **own git worktree** (`isolation:
  worktree`) so file writes never race.
- Agents develop against the RA-067 **mock emitter**, not each other —
  no runtime coupling during the parallel phase.
- The contract parity test (TS ⇄ Pydantic) is the integration tripwire:
  if any agent changes the wire shape, it fails everyone's CI, forcing
  the change back through RA-067.

---

## 5. Production-readiness checklist (owned by RA-068, designed-in earlier)

- [ ] Reconnect with exponential backoff on every WS client (UI + daemon).
- [ ] Heartbeat + staleness banner — UI never shows silently-stale data.
- [ ] Monotonic `seq`; client gap-detect → REST `/snapshot` resync.
- [ ] Per-client backpressure (drop-oldest); a slow consumer never blocks the producer.
- [ ] Failure-mode tests: kill backend, drop feed, throttle client, restart — all auto-recover.
- [ ] 1-hour soak under busy-open load: < 2GB RSS (RA-052), no leak, no UI jank.
- [ ] Windows startup-task packaging + single `run_realtime_stack.ps1` + health endpoint.
- [ ] Detector-as-library parity gate: in-process output == JSONL-path output on a fixed fixture.

---

## 6. Standing contracts (carry over from v1)

- **RA-052 memory**: long-running backend < 2GB peak RSS.
- **RA-050 schema-extensibility**: a new event family reaches the feed
  without renderer changes — now enforced at the contract layer (unknown
  family round-trips through the envelope).
- **Never** touch credentials, scheduler entries, env files, or the live
  capture/refresh processes. The backend is strictly downstream of the
  capture siblings.
- **Never** place trades; the dashboard is read-only decision support.
