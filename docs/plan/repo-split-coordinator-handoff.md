# Repo Split — Coordinator Handoff

**Document date:** 2026-06-03
**Cutover date:** Saturday 2026-06-06
**Status:** decisions locked; Phase A prep work in progress

> **One-line summary.** The `Quant-Futures-App` monorepo is being split into **two independent repos** this weekend: a **Dashboard** repo that owns live capture + decision-support visualization, and a **Trader** repo that owns algorithmic strategies + ML + backtesting. The boundary is a stable file contract (`obs01.jsonl` + zones envelope), not a shared library. Cutover is non-disruptive to live trading (executes after Friday close, verified before Sunday globex re-opens).

---

## Why this is happening

The current repo has accumulated two genuinely different products in one tree:

| Aspect | Dashboard side | Algo trader side |
|---|---|---|
| Purpose | Live decision support — operator looks at this during a session | Automated research → strategies → execution |
| Cadence | Realtime (millisecond) | Daily / weekly batch + paper/live trades |
| Stakeholder | Discretionary trader at the desk | ML research, strategy R&D |
| Ship target | Tauri desktop shell + FastAPI backend | Python services + TypeScript backtester |
| Failure cost | Trader is blind for one session | Wrong signals over many days |
| Tech bias | Live data plumbing, JS/TS chart UI | Python ML, deterministic backtests |

These have diverged in toolchain, review cadence, and reliability requirements. Today they share a single 7.1 GB `.git` directory, ~200 git branches (most algo-side), 72 parallel worktree checkouts at `D:\Quant-futures-app-*`, and one tangled set of orchestration scripts. The cost of keeping them together has crossed the cost of separating them.

---

## What changes — at a glance

### Before (today)

```
D:\Quant-futures-app\               (one repo, 7.1 GB .git, ~200 branches)
├── tools/rithmic_analytics/        ───┐
├── tools/rithmic_dashboard/           │
├── services/realtime_backend/         │ Dashboard concerns
├── apps/dashboard_shell/              │ (live visualization)
├── apps/dashboard_ui/              ───┘
├── apps/backtester/                ───┐
├── apps/strategy_runtime/             │
├── services/scalp_models/             │ Algo trader concerns
├── services/replay/                   │ (strategies / ML / execution)
├── services/market_data_sidecar/      │
├── services/broker_session_sidecar/   │
├── tools/webull/                   ───┘
└── (mixed orchestration scripts at root)
```

### After (Saturday 2026-06-06)

```
D:\Quant-Futures-Dashboard\          (~1-2 GB .git, ~500 MB repo code)
└── owns: capture probe, obs01 normalizer, FastAPI realtime backend,
    σ-zones / VPOC / VWAP envelope, Tauri shell + Vite UI,
    notification daemon, refresh upkeep, post_capture_rotate

D:\Quant-Futures-Trader\             (~1-2 GB .git, ~300 MB repo code)
└── owns: backtester, scalp ML models, strategy runtime,
    paper trading harness, broker adapters, replay engine,
    market-data sidecar, end_of_session pipeline,
    Webull integration prototype

Boundary contract:
    Dashboard writes ─────► obs01.jsonl  +  <date>_MNQ_<session>.json
                              │              (zones envelope)
                              ▼
                          Trader reads via $DASHBOARD_ROOT env var
```

Each repo is **independently deployable** and has its own GitHub remote. There is **no shared code dependency** at runtime — only a vendored `obs01_schema.{py,ts}` contract that defines the file format both sides agree on.

---

## Decisions already locked

These are not up for re-litigation. Surfaced and approved 2026-06-03:

| # | Decision | Why |
|---|---|---|
| 1 | Two separate repos with separate git history | Per-repo `.git` drops from 7.1 GB to ~1-2 GB; deploy cadences can diverge |
| 2 | Dashboard produces obs01; Trader consumes via file path (no code import) | Producer/consumer boundary is the cleanest cut; no shared-library coupling |
| 3 | Cutover Saturday 2026-06-06 (after Friday close, before Sunday globex open) | Zero impact on live trading; full weekend for verification + rollback |
| 4 | Preserve per-project history via `git filter-repo` | Keep blame + commit history; smaller per-repo size; old monorepo retained as archive tag |
| 5 | `apps/operator_console/` is DISPOSED (not migrated to either repo) | Already half-deleted in-tree; completing the removal |
| 6 | `end_of_session_pipeline.ps1` lives in Trader; calls Dashboard via `$DASHBOARD_ROOT` env var | Single canonical entry point for end-of-session work |

---

## What goes where (full inventory)

Based on a 106-row classification audit completed 2026-06-03 (committed to `docs/plan/repo-split-classification.csv`):

### Dashboard repo (18 top-level items)

| Path | Role |
|---|---|
| `tools/rithmic_analytics/` | Envelope computation, σ-zones v2, daily_zones, absorption (currently degraded — see open items) |
| `tools/rithmic_dashboard/` | Refresh-upkeep loop, scheduled-task helpers, dashboard generation |
| `services/realtime_backend/` | FastAPI WS, self-normalize, /snapshot, /health, depth stream, methodology health |
| `services/notification_daemon/` | RA-062 Windows toast daemon for CRITICAL signals |
| `apps/dashboard_shell/` | Tauri desktop wrapper (mnq-dashboard-shell.exe) |
| `apps/dashboard_ui/` | Vite/React UI loaded by the Tauri shell |
| `scripts/launch_mnq_dashboard_shell.ps1` | Canonical launcher (backend + refresh + shell) |
| `scripts/infra/capture-rithmic-probe.py` | Rithmic capture probe |
| `scripts/maintenance/` | post-crash repair tools (MBP1 sibling repair, etc.) |
| `Start-MNQ-Dashboard.cmd` | One-click launcher entry point |
| `post_capture_rotate.ps1` | Envelope refresh + calibration + backend bounce |
| `run_live_realtime_stack.ps1` | Realtime stack supervisor |
| `run_realtime_stack.ps1` | Older variant — likely consolidate |
| `contracts/obs01_schema.{py,ts}` | Vendored copy of the obs01 file contract |
| `data/captures/`, `data/zones/`, `data/calibration/` | Capture archive (gitignored bulk) |
| Discord webhook for FAIL alerts | Per-repo env var |

### Trader repo (41 top-level items)

| Path | Role |
|---|---|
| `apps/backtester/` | Forward-return-labels CLI, replay-dataset-input, strategy-fingerprint, capability-assessment, held-out validation |
| `apps/strategy_runtime/` | Paper-trading harness, broker adapter, order-lifecycle state machine, journal formatter |
| `services/scalp_models/` | RA-094 train / score / evaluate / inference (5 setup × 5 horizon cells) |
| `services/replay/` | Signal/setup replay from obs01 |
| `services/market_data_sidecar/` | Ingest, retention, gap reports, MBO order lifecycle, MBP10 price state |
| `services/broker_session_sidecar/` | Broker session state |
| `tools/webull/` | Webull HMAC-SHA1 prototype (CURRENTLY MISSING — see open items) |
| `scripts/ml/`, `scripts/sim/`, `scripts/rel/`, `scripts/orch/` | Algo-side scripting (~50 scripts) |
| `contracts/obs01_schema.{py,ts}` | Vendored copy (must match Dashboard's) |
| `contracts/events/` | Strategy runtime event payloads |
| `contracts/realtime/` | Slim vendored copy of realtime contract (replay imports `SignalPayload`, `Tier`) |
| `config/paper/` | Paper-trading config |
| `docs/plan/cycle4-*`, `docs/plan/MOC-*`, `docs/plan/qfa-*` | Algo dispatch packets and plan docs |
| `docs/research/moc-family-*` | MOC research |
| `end_of_session_pipeline.ps1` | Calls Dashboard's `post_capture_rotate.ps1` via `$DASHBOARD_ROOT`, then runs replay → labels → score → evaluate |
| `score_and_evaluate.ps1` | Standalone score+evaluate (consumes obs01 from Dashboard's path) |

### Disposed (33 items — neither repo)

- `apps/operator_console/` (already mid-removal)
- `legacy_reference/`, `legacy_seed/`
- Root `broker_session_sidecar/` shim (`services/`-version kept)
- `apps/strategy_runtime.zip`, `services/market_data_sidecar.zip`
- All 72 parallel worktree dirs at `D:\Quant-futures-app-*` (algo branches; bulk-decommissioned via `git worktree remove`)
- ~16.7 GB `scratch/ra093b-run1/` after cold-archive
- `.tmp/`, `.cache/`, stale `__pycache__/`
- 53 merged local branches + ~150 stale remote branches

### Shared (14 items vendored into BOTH)

- `contracts/obs01_schema.{py,ts}` — the obs01 JSONL format definition
- `contracts/realtime/events.py` (slim subset that `services/replay` consumes)
- `docs/observability/OBS-01.md` — obs01 envelope spec
- The `DASHBOARD_ROOT` / `TRADER_ROOT` env var convention (documented, not a file)

---

## Timeline

```
Wed 2026-06-03  ──┐  Phase A (in progress)
                  │  ├─ A1 classification audit            DONE
Thu 2026-06-04   ─┤  ├─ A2 hard-coded path audit          DONE
                  │  ├─ A3 obs01 schema extraction         pending
                  │  ├─ A4 cutover runbook                 pending
                  │  ├─ A5 git filter-repo dry-run         pending
                  │  ├─ A6 create empty GitHub repos       pending
                  │  └─ A7 dispose candidates list         DONE
                  │
Fri 2026-06-05  ──┤  Phase B (after 13:30 PT EoS pipeline completes)
                  │  ├─ stop all live processes
                  │  ├─ tag archive/pre-split-2026-06-05
                  │  └─ full backup to cold storage
                  │
Sat 2026-06-06  ──┤  Phase C (cutover) — ~4-6 hours wall clock
                  │  ├─ clone + filter-repo Dashboard
                  │  ├─ clone + filter-repo Trader
                  │  ├─ apply all hard-coded path fixes (49 sites identified)
                  │  ├─ set up cross-repo file contract (DASHBOARD_ROOT env)
                  │  ├─ re-register scheduled tasks at new paths
                  │  ├─ smoke each side end-to-end
                  │  └─ archive old D:\Quant-futures-app\ to D:\_archive\
                  │
Sun 2026-06-07  ──┤  Phase D (verification before globex re-opens 15:00 PT)
                  │  ├─ pre-open smoke of dashboard from new path
                  │  ├─ schedule Mon-Fri probe + EoS tasks at new paths
                  │  └─ disposable cleanup (worktree dirs, scratch)
                  │
Mon 2026-06-08  ──┘  Phase E (post-mortem after first live session on new paths)
```

Hard deadlines:
- **Fri 13:30 PT** — Phase B can begin after EoS pipeline finishes
- **Sun 15:00 PT** — globex re-opens; new paths MUST be fully smoked by then
- **Mon 13:10 PT** — EoS scheduled task on Monday must fire successfully from new path

---

## Risks + rollback

### Top 3 risks

1. **Hard-coded path missed.** 49 sites identified across 5 .ps1 launchers + scattered .py files. A2 audit confirms no env-var indirection exists today, so every path is literal. Mitigation: Phase C runs smoke checks after every path-fix block.
2. **Cross-repo file contract broken.** Trader needs to read obs01 from Dashboard's data path. Mitigation: the existing `-AnalyticsRoot` parameter in `end_of_session_pipeline.ps1` is repurposed as `$DASHBOARD_ROOT` — pattern already battle-tested, just made explicit.
3. **Sunday globex open fails entirely.** If anything is wrong by Sunday 12:00 PT, revert.

### Rollback procedure (estimated 15-30 min)

1. Stop everything launched from new paths
2. Move `D:\_archive\Quant-futures-app-pre-split-...` back to `D:\Quant-futures-app\`
3. Re-enable old `MNQ_*` scheduled tasks
4. Launch via old `Start-MNQ-Dashboard.cmd`
5. Verify against `archive/pre-split-2026-06-05` tag

The new GitHub repos stay (no harm); next attempt can build on what was learned.

---

## Open items needing resolution before cutover

These got surfaced by the A1 audit. None block the timeline yet but should be closed by Friday:

| Item | Impact | Owner |
|---|---|---|
| `tools/webull/` is in MEMORY.md but NOT on disk. Was it deleted, never committed, or in a worktree? | Trader repo would ship without the Webull HMAC prototype | Operator confirms before C2 |
| `contracts/` has 36 MB of `.mypy_cache/` artifacts | Gitignore in Phase C | Bundled with C path fixes |
| 10 stray `services/realtime_backend_*.log{,.err}` files at services root | Move under `logs/` and gitignore | Phase C cosmetic |
| Root CI files (`tsconfig.json`, `vitest.config.ts`, `package.json`) reference now-disposed operator_console workspaces | Phase C must regenerate them per-repo | Bundled with C |

---

## What another coordinator should know / do

### If you're working on the algo side
- **In-flight branches:** the 72 worktrees at `D:\Quant-futures-app-*` are all algo-branch checkouts (`cycle4-*`, `qfa-*`, `MOC-*`, `v2-pf-c-late-am-paper-observation-*`, `adr-*`). All of these branches survive the split — they end up in the Trader repo with full history.
- **Before Friday EOD:** push or commit any uncommitted work in any worktree. `git worktree remove --force` will be run on all 72 during cleanup.
- **Pipeline contract:** Trader's `end_of_session_pipeline.ps1` will require `$env:DASHBOARD_ROOT` to be set (defaults to `D:\Quant-Futures-Dashboard\`). Local scripts that bypass that env var will need updating.

### If you're working on the dashboard side
- **No branch concerns** — dashboard work is happening on a small number of branches.
- **Live system:** capture probe + backend + Tauri shell run continuously through cutover prep. Phase B stops them only AFTER Friday's EoS pipeline finishes at ~13:30 PT.
- **Scheduled tasks:** `MNQ_EndOfSession_Shadow_*` and `MNQ_MBP1_Crash_Repair_*` are re-registered with new paths in Phase C7. Operator must NOT manually re-register old ones during the cutover window.

### Both sides
- **Cross-repo PRs** during the transition aren't a thing yet — each repo is self-contained at the file-contract boundary.
- **Shared schemas** (`contracts/obs01_schema.{py,ts}` + `contracts/realtime/events.py`) are vendored copies, not a shared package. Changes to either need to be applied in BOTH repos manually until the churn justifies promoting to a published package.
- **Memory notes / runbook references** still pointing at `D:\Quant-futures-app\` should be updated as you encounter them. Not blocking — Phase E does a sweep.

---

## Artifacts produced so far (all committed to `feat/ra067-realtime-contract`)

- `docs/plan/repo-split-2026-06-03.md` — internal phase-by-phase work plan (the document driving the work)
- `docs/plan/repo-split-classification.csv` — 106-row inventory (path → side → rationale)
- `docs/plan/repo-split-hardcoded-paths.csv` — 49-row hard-coded-path audit
- `docs/plan/dispose-candidates.md` — ~65-115 GB of reclaimable disk with per-item recommendations
- `docs/plan/repo-split-coordinator-handoff.md` — this document

To follow along:
```
git -C D:/Quant-futures-app log --oneline feat/ra067-realtime-contract docs/plan/
```

---

## Contact / questions

Owner: Neel (operator + lead).
Cutover executor: AI coordinator (this conversation; resumes work via the task tracker).
Next coordination touchpoint: Friday 2026-06-05 12:00 PT to confirm Phase B readiness.
