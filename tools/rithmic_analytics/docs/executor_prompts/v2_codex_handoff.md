# v2 Realtime Dashboard — Codex Engineering Handoff

You are picking up the v2 realtime MNQ dashboard build. A coordinator/reviewer
(previous session) did the work below and now reviews your pre-build sweeps and
ship reports. **Read this whole doc before touching code.**

---

## 0. How we work (protocol)

1. Per ticket: read the spec → investigate the code → post a **pre-build sweep**
   as a single message (plan paragraph, ambiguity points + recommended defaults,
   phase/time estimates, anything found reading the code). **Wait for green-light.**
2. Build phases sequentially. Verify (tests + ruff + mypy + the relevant smoke).
3. Post a **ship report** with verification numbers, then a **surgical,
   path-scoped commit** (see §6).
4. Surface mid-build ambiguities rather than guessing.

---

## 1. Where things are

- **Branch:** `feat/ra067-realtime-contract` (HEAD `49cefeb`), 17 commits on
  baseline `bd1e8c5`. Stay on this branch.
- **Repo root:** `D:\Quant-futures-app`. Windows + PowerShell; git-bash also available.
- **Components:**
  - `contracts/realtime/` — frozen WS wire contract (Pydantic ⇄ TS, parity-tested) + mock emitter (RA-067)
  - `services/realtime_backend/` — FastAPI/WebSocket backend, detectors-as-library (RA-060) + `config/` (RA-063)
  - `services/notification_daemon/` — Windows toast daemon (RA-062)
  - `apps/dashboard_ui/` — React 18 + TS + Vite + lightweight-charts v5 (RA-061)
  - `tools/rithmic_dashboard/` — detection pipeline (RA-046–RA-059, iceberg, aggressor, MBO tracker) + calibration CLIs
  - `tools/rithmic_analytics/` — capture normalize (`normalize_probe_incremental`), zones (`daily_zones`)
- **Read these docs first (in order):**
  1. `tools/rithmic_analytics/docs/v2_realtime_architecture.md` — stack + architecture + parallel-execution map
  2. `tools/rithmic_analytics/docs/tickets.md` — search RA-060…RA-071 (the ticket specs)
  3. `tools/rithmic_dashboard/docs/iceberg_tolerance_calibration.md` — RA-066 findings
  4. `tools/rithmic_analytics/docs/incident_mbo_ft_gap.md` — RA-064 (why Rithmic has no F/T)

## 2. Current state (all shipped + green)

The full v2 stack is committed and green end-to-end. Capstone review (a cloud
multi-agent pass) found one blocker (RA-069, fixed) + 4 MEDIUM (fixed) + LOWs
(swept). The 1h RA-052 memory soak PASSED (181MB peak, no leak). The dashboard
runs (mock + real modes).

Commits (newest first): RA-070 self-normalize · Vite-host fix · RA-066 proxy ·
RA-066 B-a FIFO · RA-066 A calibration · RA-069 LOW/MEDIUM/blocker · RA-068
integration+hardening · RA-065 priority · RA-062 daemon · RA-061 UI · RA-063
config · RA-060 backend · RA-067 contract(+amend) · RA-058/059 detectors.

## 3. Immediate next work — RA-071 (complete the V1 migration)

User goal: **completely migrate away from the V1 HTML dashboard.** RA-070 (the
self-normalize keystone) is shipped behind an off-by-default flag. RA-071 finishes
it. Spec is in `tickets.md`; the split is:

**You CAN build (code/docs — no running-process risk):**
1. Reshape `tools/rithmic_dashboard/scripts/run_local_probe_refresh.ps1`: drop the
   **`cli.generate` HTML** step (v1 view retired) while preserving normalize and
   `daily_zones`. Normalize ownership is an operator cutover: pre-cutover the
   loop owns it; post-cutover the backend owns it via `RA60_SELF_NORMALIZE=1`
   and the operator starts the loop with `-SkipNormalize`.
2. Retire `rithmic_dashboard.cli.generate` + `templates/dashboard.html.j2`
   (**archive, do not delete** — keep history/reference).
3. Docs → v2-only: `operations.md`, the onboarding doc, the architecture doc.

**The user does (ops cutover — DO NOT do this yourself):**
4. Atomically flip `RA60_SELF_NORMALIZE=1` **and** stop the external loop's
   normalize step. **⚠ These must not overlap** — two normalizers writing the same
   `obs01`/`mbo` + `normalize_state` = double-write corruption (see §4).

**Validation before cutover (you can run, isolated only):** a flag-on backend
**must not** run against the live capture while the external refresh loop is
running (double-write). Validate in isolation: copy a raw capture to a temp
`analytics_root`, run a flag-on backend there, measure per-tick normalize latency
vs the 500ms `min_compute_interval`, and re-run the RA-052 soak. Then the user
cuts over with monitoring.

## 4. Critical invariants — DO NOT VIOLATE

- **Double-write coupling (RA-070/071):** the backend self-normalize
  (`Settings.self_normalize`) and any external normalizer cannot run concurrently.
  The flag is off by default for exactly this reason. Never enable it in a config
  that also runs the refresh-loop normalize.
- **Never touch the capture/refresh/probe pipeline or credentials.** Specifically:
  do not start/stop/modify the live capture, the refresh loop process, Task
  Scheduler, `.env`, or `scripts/infra/capture-rithmic-probe.py` (it is currently
  modified in the working tree by someone else — **never stage it**; see §6). The
  backend writes only the derived `obs01`/`mbo` siblings, never raw, never the probe.
- **Read-only decision support — never add trade execution.**
- **Contract is frozen (RA-067).** Changing the wire shape means updating
  `events.py` AND `events.ts` together; the parity tripwire (`contracts/realtime/
  tests/test_parity.py`) fails on drift. Don't fork it in a consumer.
- **RA-052 memory:** backend stays < 2GB. RA-050 extensibility: an unknown event
  family must round-trip through the envelope.
- **Detectors are reused as a library, not rewritten** (RA-046–RA-059). Detector
  logic changes are separate tickets.

## 5. Other open work

- **RA-066 Part B-b (BLOCKED on a data decision — user's call, not yours to
  resolve):** flipping the iceberg priority channel (`admit_priority_confirmation`)
  on needs F/T precision validation. The databento corpus (Feb–Apr) has **zero
  date overlap** with our Rithmic captures (May), so true precision needs acquiring
  ~9 days of databento `mbo` for the May dates. The Rithmic-only proxy
  (`cli/estimate_priority_fill_proxy.py`) showed the channel is mostly signal
  (~12.6% near-certain cancels). FIFO direction is already validated (B-a). Until
  the user acquires data or approves a hybrid gate, `admit_priority_confirmation`
  stays `False`. **Do not flip it.**
- **RA-072 (optional):** refresh-loop robustness (supervised/auto-restart). Task
  Scheduler territory → coordinate, don't do unilaterally.

## 6. Commit discipline

- **Surgical, path-scoped `git add` only — never `git add -A`.** The working tree
  carries large unrelated churn (`apps/operator_console/**` deletions,
  `strategy_runtime` mods, and **`scripts/infra/capture-rithmic-probe.py` (M,
  sensitive)**). Always `git diff --cached --name-only` before committing and
  confirm nothing unrelated is staged.
- One commit per ticket/logical unit. End the message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- LF→CRLF warnings on `git add` are benign (Windows line endings).
- Commit only when the work is verified green.

## 7. Verification commands (per package)

```
# contracts
cd D:\Quant-futures-app\contracts\realtime && python -m pytest -q && python -m ruff check . && python -m mypy -p contracts.realtime

# backend (CANONICAL mypy invocation — see gotchas)
cd D:\Quant-futures-app\services\realtime_backend && python -m pytest -q && python -m ruff check .
cd D:\Quant-futures-app\services && python -m mypy -p realtime_backend --config-file realtime_backend/pyproject.toml

# config sub-package (its own pytest root)
cd D:\Quant-futures-app\services\realtime_backend\config && python -m pytest -q

# daemon
cd D:\Quant-futures-app\services\notification_daemon && python -m pytest -q && python -m ruff check .

# UI
cd D:\Quant-futures-app\apps\dashboard_ui && npx vitest run && npx tsc -b --noEmit && npx eslint . && npm run build

# dashboard detectors
cd D:\Quant-futures-app\tools\rithmic_dashboard && python -m pytest -q && python -m ruff check . && python -m mypy rithmic_dashboard

# analytics (full suite ~3min — has slow real_globex tests)
cd D:\Quant-futures-app\tools\rithmic_analytics && python -m pytest -q && python -m ruff check . && python -m mypy rithmic_analytics
```

## 8. Gotchas (these cost time if you don't know them)

- **mypy invocation is fragile under the nested `services/` namespace.** Use the
  canonical invocations above (`-p package --config-file ...` from the right cwd).
  Running `mypy .` or on bare file paths double-maps modules and reports spurious
  import errors. `_scratch/` is mypy-excluded + gitignored (backend runtime scratch).
- **Don't run two pytest processes over the SAME package concurrently** — the slow
  `real_globex` analytics tests + a shared `.pytest_basetemp` race and produce
  phantom errors. Disjoint packages are fine in parallel.
- **Backend reads NORMALIZED siblings.** `compute_live_signals` reads trades from
  the `obs01` sibling (preferred, raw fallback) and MBO from the `.mbo.jsonl`
  sibling. A stale `obs01` is *preferred over* fresh raw — which is the whole
  reason RA-070 exists.
- **Cached-sibling invalidation:** pre-RA-065 normalized `.mbo.jsonl` lacks the
  `priority` field; only post-RA-065 captures carry it. To regenerate, delete the
  sibling + re-normalize.
- **UI binds `127.0.0.1`** now (RA-070 era fix); both `127.0.0.1:5173` and
  `localhost:5173` work. Backend + mock are on `8765`.
- **Daemon uses `windows_toasts`** (installed); `win11toast` is not.
- **Launch the stack:** `.\run_realtime_stack.ps1` (real) or `-Mock` (synthetic,
  deterministic CRITICAL within ~60s). Mock is the reliable "see it work" path.

## 9. First action

Post a **pre-build sweep for RA-071** (loop reshape + generator retirement + docs
— the pieces you can build; leave the ops cutover to the user). Surface: which
flags/mode to add to `run_local_probe_refresh.ps1`, archive-vs-delete handling for
`cli.generate`/the j2 template, the docs to update, and the isolated flag-on
validation plan. Wait for the coordinator's green-light before writing source.
