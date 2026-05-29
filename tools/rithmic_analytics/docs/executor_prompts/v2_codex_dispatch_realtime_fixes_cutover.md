# Codex Dispatch — v2 real-mode fixes + RA-070 cutover enablement

Coordinator/reviewer (prior session) wrote this. Work it ticket-by-ticket;
post a pre-build sweep per ticket and wait for green-light before source edits.
**Read `v2_codex_handoff.md` first** (branch, components, invariants, verification
commands, gotchas). Branch `feat/ra067-realtime-contract` @ `14d451f`.

---

## Why this dispatch

Live test of the real (non-mock) v2 stack showed the dashboard connects but
shows ~only the initial snapshot. Verified root causes:

- **Chart has no candle stream** — the backend emits **no `price_tick` frames**
  (only the RA-067 mock did); the chart builds candles from `price_tick`.
- **Live Feed + Session History empty on connect** — the reducer's snapshot
  branch never hydrates them from `snapshot.recent_signals` (the backend ships
  ~40, they're invisible until post-connect events).
- **"Degraded — stale capture" banner pre-cutover** — the backend reads the
  `obs01` sibling, which (pre-cutover) the external loop only refreshes every
  5 min, while the staleness threshold is 30 s. This is **honest** (the served
  data IS up to 5 min old) and is resolved by the cutover, NOT by code.
- `open_scenarios` is hardcoded `[]` in the snapshot builder.

---

## Tickets (build in this order)

### RA-073 — backend emits `price_tick` (P1)
`services/realtime_backend` emits no `price_tick`. Add emission of a
`PriceTickPayload` (price + bid/ask/volume from the latest trade in the `obs01`
tail) on each compute, **deduped when unchanged**, so the v2 chart renders a live
candle stream in real mode. The contract family already exists (don't touch the
wire shape); the mock is the reference for the consumer. Owner: RA-060 backend
(feed/signals emit path). Note: pre-cutover these ticks are ~5-min laggy (obs01
cadence) — that's fine; the emission must exist regardless, and goes live at the
cutover.

### RA-074 — UI hydrates feed/history from the snapshot (P1)
`apps/dashboard_ui/src/store/reducer.ts` `isSnapshot` branch sets
price/sigma/regime/zones/scenarios but not `feed`/`history`. On the snapshot
frame, seed Live Feed (last `FEED_CAP`) + Session History (last `HISTORY_CAP`)
from `snapshot.recent_signals` (reuse the existing feed-family mapping). Must be
**idempotent on resync** (don't double-append when a resync snapshot arrives).
Owner: RA-061 UI. Independent of the cutover.

### RA-076 — cutover enablement + runbook (P1) — STAGE ONLY, do not execute the live flip
Make the RA-070 cutover a single, validated, reversible operation the **operator**
triggers. You build the enablement + the runbook + run the isolated validation;
**you do NOT stop/start live processes or flip the flag in production** (that's
the operator's hands-on step — see Hard Constraints).

Build:
1. **`run_realtime_stack.ps1 -SelfNormalize`** switch → launches the backend with
   `RA60_SELF_NORMALIZE=1` (sets the env before the backend command). Default off.
2. **Document the refresh-loop v2 mode**: post-cutover the loop runs
   `-SkipNormalize` (backend owns normalize; the loop keeps `daily_zones` for the
   zone layer at 5-min). The `-SkipNormalize` flag already exists.
3. **Isolated validation** (you run this — see below): flag-on backend against a
   COPY of raw in a temp `analytics_root`; measure per-tick normalize latency vs
   the 500 ms `min_compute_interval` + re-run the RA-052 soak. Confirms the
   flag-on backend performs before the real cutover.
4. **`docs/operations.md` cutover runbook** (you author; the operator executes):
   exact commands, order, per-step verification, and rollback (below).

### RA-075 — populate `open_scenarios` in the snapshot (P2)
`signals.py:525` hardcodes `open_scenarios=[]`. Map active scenarios (within
proximity of current price; the dashboard pipeline already synthesizes them) into
`ScenarioState`. Do **after** RA-073/074.

### Optional — banner copy (finding 1)
You MAY soften the degraded-banner *text* ("normalized feed lagging" vs "capture
stale"). You may **NOT** change the staleness *detection source* — see constraints.

---

## Hard constraints (DO NOT VIOLATE)

1. **DO NOT change the staleness detection source.** It stays on the served
   `obs01`. Reporting raw-capture freshness would make the UI claim "live" on
   5-min-stale data — a dangerous false-confidence regression for a trading tool.
   The cutover resolves the banner honestly (continuous `obs01`). Copy-only tweak.
2. **DO NOT execute the live cutover.** You stage it + write the runbook. The
   operator stops the running loop, starts the flag-on backend, and restarts the
   loop in v2 mode. Never start/stop/modify the live capture, the running refresh
   loop, Task Scheduler, `.env`, credentials, or
   `scripts/infra/capture-rithmic-probe.py` (it is `M` in the tree — **never
   stage it**).
3. **Double-write rule — exactly one normalizer at a time.** The cutover sequence
   must STOP the external loop's normalize BEFORE the backend's flag-on first
   compute. A brief no-normalizer gap is harmless; an overlap races the shared
   `normalize_state` offset → corruption. Bake a preflight check into the runbook
   (confirm the old loop's normalize is stopped before starting the flag-on
   backend).
4. **Frozen contract** (`events.py` ⇄ `events.ts`, parity tripwire). `price_tick`
   already exists — don't change the wire shape.
5. **Read-only decision support — never add trade execution.**
6. **Surgical, path-scoped commits.** `git diff --cached --name-only` before each
   commit; never stage unrelated churn or `capture-rithmic-probe.py`. End messages
   with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
7. RA-052 (<2GB) + RA-050 extensibility hold.

---

## Cutover runbook (you author it into `operations.md`; the operator runs it)

Preflight (operator): RA-073 + RA-074 shipped & green; isolated validation passed.

1. **Stop** the external refresh loop (operator). Confirm no normalize process is
   running and `normalize_state` mtime has stopped advancing.
2. **Start** the backend with self-normalize: `.\run_realtime_stack.ps1
   -SelfNormalize`. Verify: `/health` ok; `obs01`/`mbo` mtime now advances every
   tick; the degraded banner clears; the chart shows live ticks (RA-073); feed is
   populated (RA-074).
3. **Restart** the refresh loop in v2 mode: `run_local_probe_refresh.ps1 -Loop
   -SkipNormalize` (daily_zones only, for the zone layer).
4. **Verify**: exactly one normalizer (the backend); `obs01` advancing
   continuously; dashboard live end-to-end.

Rollback (if anything looks wrong): stop the flag-on backend, restart the refresh
loop WITH normalize (drop `-SkipNormalize`) → back to pre-cutover within seconds.
Provide these exact commands in the runbook.

---

## Sequencing

RA-073 + RA-074 (sweep both — disjoint backend/UI — build, verify, commit) →
RA-076 (enablement + isolated validation + runbook) → **operator executes the
cutover** → RA-075 follow-up.

## First action

Post a **pre-build sweep for RA-073 + RA-074** (single message; they're disjoint).
Add the ticket entries to `tickets.md` as part of the work. Wait for the
coordinator's green-light before source edits.
