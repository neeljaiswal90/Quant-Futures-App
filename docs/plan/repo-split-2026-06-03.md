# Repo split plan — Dashboard vs Algo Trader

**Status:** draft for review · created 2026-06-03 · target cutover Sat 2026-06-06

## TL;DR

Split the single `Quant-Futures-App` repo into two clean repos:

- **`Quant-Futures-Dashboard`** — owns the live decision-support stack: Rithmic capture, obs01 normalization, FastAPI realtime backend, Tauri dashboard shell, the σ-zones / VPOC / VWAP analytics envelope.
- **`Quant-Futures-Trader`** — owns the algorithmic trading stack: backtester, strategy runtime, paper-trading harness, scalp ML models, replay engine, broker adapters, market-data sidecars.

The boundary is the **obs01 file format**. Dashboard PRODUCES obs01 as a side-effect of running the live capture; Trader CONSUMES obs01 (and the zones JSON envelope) as inputs to replay, labels, training, and inference. A small `obs01-schema` contracts package is the only code dependency between them and is vendored into both initially.

Preserve git history per project via `git filter-repo`. Expected per-repo `.git` size after split: ~1–2 GB each (down from the current 7.1 GB monorepo).

Cutover happens after Friday's session close, with Sunday for verification before globex re-opens.

---

## Decisions confirmed 2026-06-03

| # | Question | Choice |
|---|---|---|
| 1 | On-disk structure | **Two separate repos** with separate git history |
| 2 | Shared code ownership | **Dashboard owns obs01 producer**; Trader consumes via stable file contract |
| 3 | Cutover timing | **After this weekend** — Saturday 2026-06-06 |
| 4 | Git history | **Preserve via `git filter-repo`** |

---

## Target layout

```
D:\Quant-Futures-Dashboard\                       (~1–2 GB .git, repo-only ~500 MB)
├── tools/rithmic_analytics/             # envelope, σ-zones v2, daily_zones, absorption (degraded)
├── tools/rithmic_dashboard/             # refresh upkeep, scheduled-task helpers
├── services/realtime_backend/           # FastAPI WS, self-normalize, snapshot, depth (RA-070/RA-081)
├── apps/dashboard_shell/                # Tauri desktop wrapper
├── apps/dashboard_ui/                   # Vite/React UI (lightweight-charts)
├── scripts/maintenance/                 # repair_mbp1_sibling.py, post_capture_rotate.ps1
├── scripts/launch_mnq_dashboard_shell.ps1
├── scripts/infra/capture-rithmic-probe.py
├── contracts/obs01_schema.py            # vendored copy (source of truth)
├── data/                                # captures, zones, obs01, calibration  (gitignored bulk)
└── Start-MNQ-Dashboard.cmd

D:\Quant-Futures-Trader\                          (~1–2 GB .git, repo-only ~300 MB)
├── apps/backtester/                     # forward-return-labels, replay-dataset-input, strategy-fingerprint
├── apps/strategy_runtime/               # paper-trading, broker adapter, order lifecycle
├── apps/operator_console/               # (if kept — currently has uncommitted deletions)
├── services/scalp_models/               # train / score / evaluate / inference (RA-094)
├── services/replay/                     # signal/setup replay from obs01
├── services/market_data_sidecar/        # ingest, retention, gap reports
├── services/broker_session_sidecar/     # broker session state
├── services/notification_daemon/        # alerts
├── tools/webull/                        # broker integration (HMAC-SHA1 prototype)
├── scripts/                             # ml/, sim/, rel/, orch/, infra/ (algo-only)
├── contracts/obs01_schema.py            # vendored copy (must match Dashboard's)
├── contracts/events/                    # strategy_runtime event payloads
├── docs/plan/                           # the cycle4-*, MOC-*, qfa-* dispatches
├── config/paper/                        # paper-trading config
├── end_of_session_pipeline.ps1          # consumes obs01 from Dashboard's output path
└── score_and_evaluate.ps1
```

**Shared file contract (NOT a code dependency):**
- Dashboard writes: `<dashboard>/data/captures/<date>/MNQ_<session>.obs01.jsonl` and `<dashboard>/data/zones/<date>_MNQ_<session>.json`
- Trader reads: a configurable `DASHBOARD_DATA_ROOT` env var pointing at `D:\Quant-Futures-Dashboard\tools\rithmic_analytics\data\` (or a symlink). The end_of_session_pipeline.ps1 already takes `-AnalyticsRoot` — that's how the contract is enforced.

---

## Phase A — Prep (now → Fri 2026-06-05 12:00 PT) · NON-DESTRUCTIVE

These can all happen during market hours without touching live state.

### A1. Inventory & classification (1 day)
- For every file in `apps/`, `services/`, `tools/`, `scripts/`, `contracts/`, `docs/`, `config/`: assign to `dashboard | algo | shared | dispose`.
- Output: `docs/plan/repo-split-classification.csv` — one row per top-level dir, with rationale.
- Special cases to resolve in the inventory:
  - `apps/operator_console/` — git status shows it's deleted-but-tracked. Confirm with user whether to revive or drop.
  - `apps/dashboard_ui/` — not yet inspected; might be web UI for dashboard OR legacy.
  - `services/broker_session_sidecar/` and `services/market_data_sidecar/` — algo-side per assumption, verify.
  - `services/notification_daemon/` — could be either.
  - `legacy_reference/`, `legacy_seed/` — likely dispose.
  - `broker_session_sidecar/` at repo root (different from `services/broker_session_sidecar/`).
  - Root-level `*.ps1` scripts — split each: `Start-MNQ-Dashboard.cmd`, `post_capture_rotate.ps1`, `run_live_realtime_stack.ps1` → Dashboard; `end_of_session_pipeline.ps1`, `score_and_evaluate.ps1` → Trader; `run_realtime_stack.ps1` → likely Dashboard.

### A2. Hard-coded path audit (½ day)
- Grep across both code and scripts for `D:\Quant-futures-app` (case-insensitive, with `/` and `\` variants).
- Output: a list of every file × line that hard-codes the path, with proposed replacement.
- Two categories:
  - **Tier 1 (must fix before cutover):** runtime code, scripts that will be re-scheduled
  - **Tier 2 (can ignore initially):** docs, executor prompts, scratch artifacts

### A3. Define obs01 contract package (1 day)
- Identify the schema definition currently scattered across:
  - `tools/rithmic_analytics/rithmic_analytics/core/loader.py` (the consumer side)
  - `services/realtime_backend/` self-normalize emit (the producer side)
  - `services/replay/` consumer
- Extract to a single `contracts/obs01_schema.py` (Python) + `contracts/obs01_schema.ts` (TS for backtester).
- Vendor identical copies into both repos at cutover; later we can promote to a shared package if maintenance churn justifies it.

### A4. Write the cutover runbook (½ day)
- Step-by-step `runbook-cutover-2026-06-06.md` — every command, every verification check, every rollback.
- Includes: scheduled-task re-registration, scheduled-task path updates, capture probe restart paths, dashboard shortcut updates.

### A5. `git filter-repo` dry-run (½ day)
- Clone the repo to two scratch dirs: `D:\split-test\dashboard\` and `D:\split-test\trader\`.
- For each, write the path-include / path-exclude rules based on A1's classification.
- Run `git filter-repo --analyze` to confirm output sizes ≈ 1–2 GB each.
- Confirm a sample of `git log -- <file>` works on the filtered repos.
- Document the exact filter-repo invocations.

### A6. Set up new GitHub repos (private, empty) (10 min)
- Create `neeljaiswal90/Quant-Futures-Dashboard` and `neeljaiswal90/Quant-Futures-Trader`.
- DO NOT push yet — just reserve the names + set up `.gitignore`, basic README.

### A7. Build a `dispose` cleanup list (½ day)
- 17 GB scratch/, lots of worktree dirs at `D:\Quant-futures-app-*`, archived zips (`apps/strategy_runtime.zip`, `services/market_data_sidecar.zip`).
- These do NOT need to be split — they need to be deleted or moved to cold storage.
- Output: `docs/plan/dispose-candidates.md`.

---

## Phase B — Friday wind-down (Fri 2026-06-05 13:00–18:00 PT)

After globex closes Friday at 13:00 PT and EoS pipeline finishes:

### B1. Quiesce
- Let EoS pipeline complete normally (writes labels/predictions/performance for Friday's session).
- Stop capture probe + backend + Tauri shell + refresh loop.
- Disable all `MNQ_*` scheduled tasks (don't delete; just disable so they don't fire over the weekend).

### B2. Final clean state commit
- Commit any work-in-progress to the existing repo.
- Tag the repo: `git tag archive/pre-split-2026-06-05 && git push origin archive/pre-split-2026-06-05`.
- This is the rollback anchor.

### B3. Local backup
- Snapshot the entire `D:\Quant-futures-app\` to a backup location (USB drive or network share).
- Verify the backup is readable from another machine.

---

## Phase C — Saturday cutover (Sat 2026-06-06 morning) · DESTRUCTIVE

This is the big one. Estimated 4–6 hours.

### C1. Build new Dashboard repo
- `cd D:\` then `git clone D:\Quant-futures-app D:\Quant-Futures-Dashboard`
- Run the filter-repo invocation from A5: keep dashboard paths, drop algo paths.
- Verify size and that `git log` is sane.
- Apply hard-coded-path fixes from A2.
- `git remote set-url origin git@github.com:neeljaiswal90/Quant-Futures-Dashboard.git`
- `git push -u origin main`

### C2. Build new Trader repo
- Same flow: `git clone` → filter-repo → path fixes → new remote → push.

### C3. Move live data into Dashboard
- The 285 GB `tools/rithmic_analytics/data/` doesn't belong in git. Move (not copy — too big) to `D:\Quant-Futures-Dashboard\tools\rithmic_analytics\data\` (it's already there if we cloned the path, but cloning the data is wasteful; we'll move-and-symlink).
- Verify `data/captures/2026-06-05/MNQ_globex.jsonl` is readable.

### C4. Move algo-specific bulk
- `data/predictions/`, `data/performance/`, `data/zone_outcomes/`, `data/zone_snapshots/`, `data/zone_touches/`, `data/trades/` → Trader's `data/`.
- `scratch/` 17 GB → likely dispose (per A7), but keep `ra093b-run1` (live training run output) accessible to Trader.

### C5. Cross-repo path setup
- In `Quant-Futures-Trader\.env`: `DASHBOARD_DATA_ROOT=D:\Quant-Futures-Dashboard\tools\rithmic_analytics\data`
- Update `end_of_session_pipeline.ps1` to read `-AnalyticsRoot` from env or default.
- Update `score_and_evaluate.ps1` similarly.

### C6. Update Start-MNQ-Dashboard.cmd
- Point `REPO_ROOT` at `D:\Quant-Futures-Dashboard`.
- Update launcher path inside.

### C7. Re-register scheduled tasks with new paths
- `MNQ_EndOfSession_Shadow_<date>_<session>` → invokes `D:\Quant-Futures-Trader\end_of_session_pipeline.ps1`
- Any others (probe launch, refresh loop) → Dashboard paths.

### C8. Verify dashboard end-to-end
- Start probe (short duration, smoke), backend, refresh, Tauri shell.
- Confirm `/health` and `/snapshot` non-empty.
- Stop after smoke.

### C9. Verify trader end-to-end
- Run `score_and_evaluate.ps1` against Friday's session data (now consumed cross-repo).
- Confirm performance markdown emits.

### C10. Archive old repo
- Rename `D:\Quant-futures-app` → `D:\_archive\Quant-futures-app-pre-split-2026-06-05` (or move to cold storage).
- Do NOT delete — keep for ~30 days minimum as rollback.

---

## Phase D — Sunday verification (Sun 2026-06-07)

### D1. Pre-globex-open smoke
- 1 hour before globex open (14:00 PT): launch the dashboard from new path.
- Confirm capture probe args/paths are correct for Sunday's globex.
- Smoke EoS pipeline against any partial Saturday data.

### D2. Schedule next week's tasks
- Daily probe + EoS scheduled tasks for Mon–Fri (5 day-by-day registrations, or one recurring).

### D3. Disposable cleanup
- Remove worktree dirs at `D:\Quant-futures-app-*` (per A7).
- Remove `*.zip` archives.
- Optionally prune `scratch/` to <500 MB.

---

## Phase E — Monday verification (Mon 2026-06-08)

### E1. First live session on new paths
- Watch RTH open through close.
- Verify EoS pipeline auto-fires at 13:10 PT from Trader repo.
- Compare Monday's outputs against the expected schema.

### E2. Post-mortem
- Document any surprises (missed paths, broken imports, schedule misfires).
- Update the runbook for next time.

---

## Risks + rollback

### Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Hard-coded path missed; runtime errors on Sunday | Medium | High | A2 audit + grep on Saturday after cutover; smoke runs every step |
| `git filter-repo` drops a file we needed | Low | Medium | Dry-run in A5; manual diff sample-check; keep archive tag |
| Cross-repo file contract broken (Trader can't find obs01) | Medium | High | Use `-AnalyticsRoot` env var pattern that already exists in EoS pipeline |
| Backup unreadable | Low | Critical | B3 verifies the backup from a second machine |
| Sunday open fails entirely | Low | Critical | Rollback = restore `D:\Quant-futures-app\` from archive; re-enable old scheduled tasks |
| Scheduled task path mismatch | High | Medium | C7 explicitly re-creates ALL tasks with new paths; old tasks deleted not edited |

### Rollback procedure

If anything is wrong by Sunday 12:00 PT:
1. Stop everything launched from new paths.
2. Move `D:\_archive\Quant-futures-app-pre-split-...` back to `D:\Quant-futures-app\`.
3. Re-enable old `MNQ_*` scheduled tasks.
4. Launch via old `Start-MNQ-Dashboard.cmd`.
5. Verify against `archive/pre-split-2026-06-05` tag.

Expected rollback time: 15–30 min. The new repos stay on GitHub (no harm); next attempt can build on what was learned.

---

## Open items — resolutions (recorded 2026-06-03 after A1 inventory)

1. **Operator console**: **DISPOSE** (confirmed 2026-06-03). Drop entirely. Remove from root `package.json` workspaces, `vitest.config.ts`, `tsconfig.json` as part of Phase C. The 60 staged deletions are the intended end state — Phase C completes the removal.
2. **`apps/dashboard_ui/`** vs **`apps/dashboard_shell/`**: same product. `dashboard_ui` is the RA-061 Vite/React app; `dashboard_shell` is the RA-101 Tauri desktop wrapper that loads it. Both → dashboard.
3. **`legacy_reference/` and `legacy_seed/`**: both dispose (confirmed by A1).
4. **`broker_session_sidecar/` at repo root**: it's a 2-file shim (`__init__.py` + `__main__.py`) re-exporting `services.broker_session_sidecar`. Drop the root shim; keep `services/broker_session_sidecar/` (algo).
5. **`contracts/` 36 MB**: 99% is `.mypy_cache/` artifacts (~18 MB each in `contracts/` and `contracts/realtime/`). Actual code is ~60 KB. Gitignore the mypy caches in Phase C.
6. **`config/paper/`**: algo (confirmed, paper-trading config).
7. **`tools/webull/`**: DOES NOT EXIST on disk. Memory note `project_webull_openapi_integration.md` references a path that isn't present. Open NEW question — was it deleted, never committed, or in a worktree? Resolve before C2 so the algo repo isn't missing the integration.
8. **Discord webhook / alert channels**: per-repo for now. Each `.env` carries its own webhook; consolidate post-cutover if churn justifies it.

## EoS pipeline boundary — decision (recorded 2026-06-03)

`end_of_session_pipeline.ps1` currently calls BOTH sides: `post_capture_rotate` (dashboard) then `replay → labels → score → evaluate` (algo). **Decision: move the whole pipeline to the algo repo**; it invokes dashboard's `post_capture_rotate.ps1` via `$env:DASHBOARD_ROOT\post_capture_rotate.ps1` (or `-DashboardRoot` param). Tighter coupling but a single canonical entry point.

Implication for Phase C:
- Trader gets: `end_of_session_pipeline.ps1`, `score_and_evaluate.ps1`
- Dashboard exports: `post_capture_rotate.ps1` (no behavior change; just lives in dashboard repo)
- Cross-repo path glue: `DASHBOARD_ROOT` env var read at the top of `end_of_session_pipeline.ps1`, defaults to `D:\Quant-Futures-Dashboard\`.

## New open items surfaced by A1 (resolve during A3/A4/B)

- `tools/webull/` missing — needed for algo repo's broker-integration scope.
- `services/replay/runner.py` imports `contracts.realtime.events` — algo repo needs a slim vendored copy of that contract (extends the obs01_schema vendoring scope).
- `docs/observability/OBS-01.md` — the obs01 envelope spec. Move to the shared `contracts/obs01_schema/` location, vendor into both repos.
- 10 stray `services/realtime_backend_*.log{,.err}` files — move under `logs/` and gitignore as part of Phase C.
- Root CI files (`tsconfig.json`, `vitest.config.ts`, `package.json`) reference now-disposed operator_console workspaces — Phase C must regenerate them per-repo regardless.

---

## What I can start NOW (this week, non-destructive)

If approved:
- Phase A1 inventory (read-only file classification)
- Phase A2 hard-coded path audit (grep + tabulate)
- Phase A4 cutover runbook draft
- Phase A5 filter-repo dry-run (clones to scratch, doesn't touch the original)

I will NOT start A3 (obs01 contract extraction) until A1 confirms the boundary; that's a code-touching change.

I will NOT touch B/C/D until Friday's session closes.
