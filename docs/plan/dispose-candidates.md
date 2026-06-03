# Dispose candidates — A7 audit

**Status:** generated 2026-06-03 · for the repo split planned 2026-06-06

## Reclaimable disk summary

| Category | Reclaimable | Notes |
|---|---|---|
| **Worktree dirs at `D:\Quant-futures-app-*`** | ~50–100 GB (TBD) | 72 worktrees; sizes need per-tree `du` (omitted here for speed) |
| **`scratch/` subtree** | ~16.7 GB | 17 GB total, after archiving `ra093b-run1` 16.7 GB to cold storage first |
| **Zip archives + build artifacts** | ~25 MB | `apps/strategy_runtime.zip`, `services/market_data_sidecar.zip`, `.tmp/` venv |
| **Stale local branches** | metadata only | ~53 merged + ~150 stale across local + remote |
| **TOTAL reclaimable** | **~65–115 GB** | most upside is the worktrees |

The 7.1 GB `.git` repo bloat is NOT touched by these — that gets handled by the filter-repo step in C1/C2 of the cutover.

---

## Category 1: parallel worktree dirs at `D:\Quant-futures-app-*`

**Discovery:** 72 dirs match `D:\Quant-futures-app-*`. All are registered git worktrees (`git worktree list` confirmed). None track dashboard branches — every one is an algo-side feature checkout (cycle4-*, qfa-*, MOC-*, adr-*, v2-pf-c-late-am-paper-observation-*).

**Recommendation:** dispose ALL of them as part of Phase B/C. Process:

```powershell
# From the main repo:
foreach ($wt in (Get-ChildItem -Path D:\ -Directory -Filter "Quant-futures-app-*")) {
    git -C D:\Quant-futures-app worktree remove --force $wt.FullName
}
# Verify all gone:
git -C D:\Quant-futures-app worktree list
```

**`git worktree remove --force` is reversible at the branch level** — it deletes the working tree but the branch ref still exists in the main repo. To re-create later: `git worktree add <path> <branch>`.

**Worktrees to keep:**
- `D:\Quant-futures-app` (the main repo itself)
- `D:\Quant-futures-app\.claude\worktrees\frosty-cartwright-f8ca18` (internal Claude worktree, leave alone)

**Risk:** if any of those 72 worktrees has uncommitted work, `--force` discards it. Mitigation: before running, check each with `git -C <wt> status --short` and stash anything dirty. The 30-minute time investment is worth it.

**Full list of 72 worktree dirs:** see appendix below.

---

## Category 2: `scratch/` subdirectories (17 GB → target <500 MB)

| Path | Size | Recommendation | Why |
|---|---|---|---|
| `scratch/ra093b-run1/` | 16.7 GB | **archive → dispose** | Live training output. Archive to cold storage (`D:\_archive\ra093b-run1-2026-06-03\`) before deletion. Algo-side artifact; lives outside both new repos. |
| `scratch/pytest-*` (12 dirs) | ~3.8 GB | dispose | pytest tmpdir fixtures from various test runs. Re-generated on next pytest. |
| `scratch/ra109-perf-profile/` | ~50 MB | dispose | perf profiling research scratch. |
| `scratch/ra096-sweep-research/` | ~34 MB | dispose | research scratch from sweep. |
| `scratch/replay-debug/`, `scratch/replay-cli-smoke/` | ~86 KB | dispose | smoke test artifacts. |
| `scratch/qfa-119d/` | 24 KB | dispose | feature research scratch. |
| `scratch/moc-research/` | empty | dispose | empty dir. |
| `scratch/dashboard_*.png`, `scratch/depth-smoke-*.png` | small | keep | screenshots referenced in plan docs / coord notes. Move under `docs/screenshots/`. |
| `scratch/performance_in_sample.md*` | small | keep | scalp model performance reports. Move under `data/performance/`. |
| `scratch/predictions_smoke.jsonl` | small | dispose | smoke test output. |
| `scratch/snap_payload.json` | small | dispose | one-off snapshot dump. |
| `scratch/ui_stop_feature_smoke/` | small | dispose | UI smoke artifact. |

---

## Category 3: zip archives + build artifacts

| Path | Size | Recommendation | Why |
|---|---|---|---|
| `apps/strategy_runtime.zip` | 596 KB | dispose | Tracked in git status as untracked. Stale zip of strategy_runtime — source already in apps/strategy_runtime/. |
| `services/market_data_sidecar.zip` | 184 KB | dispose | Same pattern. Source in services/market_data_sidecar/. |
| `.tmp/` (venv + protobuf cache) | ~25 MB | dispose | Local dev .tmp dir. Gitignored. Recreated on need. |
| `.cache/` | 48 KB | dispose | Pip/python cache. Gitignored. |
| `services/realtime_backend_*.log{,.err}` (10 files) | small | move | Stray runtime logs polluting `services/`. Move under `logs/` and gitignore. (NOT dispose — useful for debugging recent crashes.) |
| `dist/` | ? | check | If present, build output. Likely dispose. |
| `node_modules/` | ? | keep | npm install state; needed for development. Already gitignored. |

---

## Category 4: dead branches in the local repo

`git branch -a` returns 200+ branches. Breakdown:

- **Merged into `main`:** ~53 local branches. Prune with:
  ```bash
  git -C D:/Quant-futures-app branch --merged main | grep -v '^\*\| main$' | xargs -r git -C D:/Quant-futures-app branch -d
  ```
- **Stale (no commit in 90+ days):** ~150 remote branches. Heavy hitters: `feat/qfa-611-cycle2-production`, `feat/qfa-201d-monotonic-merge`, `claude/frosty-cartwright-f8ca18`, `claude/vigorous-visvesvaraya-0445fc`, many `codex/*` experiments. Remote branches don't take local disk but they clutter `git branch -a` output. Prune via `git remote prune origin` + per-branch deletion on GitHub side.
- **Active (commits <2 weeks):** ~30 branches. The `v2-pf-c-late-am-paper-observation-*` series + recent cycle4 work + the current `feat/ra067-realtime-contract`. Keep all.

**Recommendation:** local-merged pruning is safe to do TODAY. Remote pruning waits until after the cutover (filter-repo will preserve the active set per project, the inactive ones will simply not be in the new repos).

---

## Critical warnings — DO NOT delete without archiving

1. **`scratch/ra093b-run1/` (16.7 GB)** — live training state. Archive first.
2. **Any worktree with uncommitted work** — check `git status` per worktree before bulk remove.
3. **Recent `services/realtime_backend_*.log{,.err}` files** — contain stderr from yesterday's crash. Useful for verifying the MBP1 corruption diagnosis. Move under `logs/`, don't delete yet.
4. **Anything under `data/`** — captures, zones, predictions, performance. Move into the right repo at cutover; do not bulk delete.

---

## Open items surfaced

- Per-worktree size data needed before final dispose recommendation. The 72-worktree audit got names + branches; sizes were dropped to fit. Re-run `du -sh` per worktree as part of Phase B if precise number matters.
- Need to confirm `dist/` exists at root; if yes, audit its contents before dispose.
- ~50 remote-only branches probably belong to abandoned codex experiments. Worth a single GitHub-side cleanup pass post-cutover.

---

## Appendix: full worktree list (72)

Per `Get-ChildItem -Path D:\ -Filter "Quant-futures-app-*"`:

```
Quant-futures-app-adr-0015
Quant-futures-app-adr-0016
Quant-futures-app-adr-0019
Quant-futures-app-baseline-8788576                       (detached HEAD)
Quant-futures-app-cycle4-2mnq-replay-sizing-harness-01
Quant-futures-app-cycle4-archive-frame-decode-01
Quant-futures-app-cycle4-deadline-exposure-harness-01-impl
Quant-futures-app-cycle4-hash-trace
Quant-futures-app-cycle4-heldout-artifact-evidence-extend-01
Quant-futures-app-cycle4-multi-exit-pnl-accounting-01
Quant-futures-app-cycle4-r1-v3-pairwise-replay-01
Quant-futures-app-cycle4-real-archive-multi-exit-01
Quant-futures-app-cycle4-s1
Quant-futures-app-cycle4-s2
Quant-futures-app-cycle4-v5-inference-01
Quant-futures-app-cycle4-v5-inference-02-2mnq
Quant-futures-app-cycle4-v5-verdict-reconcile-01
Quant-futures-app-dev-status-readme
Quant-futures-app-final-status-handoff-sweep
Quant-futures-app-mgmt-bug-fix-02
Quant-futures-app-mgmt-deadline-extension-01
Quant-futures-app-moc-lo-counterfactual
Quant-futures-app-moc-r1
Quant-futures-app-moc-r3
Quant-futures-app-moc-r5
Quant-futures-app-moc-r6
Quant-futures-app-moc-r7
Quant-futures-app-pr303-repair                           (detached HEAD)
Quant-futures-app-process-03
Quant-futures-app-qfa-201b
Quant-futures-app-qfa-201c
Quant-futures-app-qfa-410b
Quant-futures-app-qfa-420
Quant-futures-app-qfa-420-h1
Quant-futures-app-qfa-611
Quant-futures-app-qfa-611-cycle3-rederivation-02
Quant-futures-app-qfa-612-broker-03-paper-order-plant-lifecycle
Quant-futures-app-qfa-629
Quant-futures-app-qfa-633-live-ticker-sidecar-01
Quant-futures-app-qfa-633-shadow-replay-01
Quant-futures-app-qfa-mgmt-bug-fix-01
Quant-futures-app-qfa-mgmt-wiring-test-01
Quant-futures-app-qfa611-cycle1-production
Quant-futures-app-qfa611-stat-core
Quant-futures-app-readme-regime-shock-chart
Quant-futures-app-rederivation-02-track-b
Quant-futures-app-strategy-ids-reconcile-01
Quant-futures-app-strategy-ids-reconcile-02
Quant-futures-app-v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-acquire-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-inputs-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-bar-sigma-source-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-bar-sigma-source-window-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-daily-report-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-feature-builder-scope-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-feature-snapshot-bridge-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-implement-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-live-capture-bridge-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-monitor-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-regime-join-source-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-regime-label-source-acquire-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-regime-label-source-coverage-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-regime-label-source-inputs-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-run-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-session-regime-shock-source-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-session-state-source-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-session-vwap-prior-history-source-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-session-vwap-source-backfill-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-session-vwap-source-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-session-vwap-source-window-repair-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-signed-shock-source-extend-01
Quant-futures-app-v2-pf-c-late-am-paper-observation-source-readiness-01
```
