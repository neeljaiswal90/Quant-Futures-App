# Strategy-generation loop — coordinator handoff (01)

## Purpose and audience

This is a complete handoff for a secondary coordinator picking up the
strategy-generation ("strategy factory") workstream while operating on
the **local machine** (the `D:\Quant-futures-app` working copy with the
`D:\qfa-cache` data lake attached). It is self-sufficient: you should be
able to take the work forward from this document alone, without
replaying the prior conversation.

Read order for the underlying artifacts: design-01 (the spec), then
review-01 (the review surface and folded audit), then the SCOPE-01
ticket (the implementation contract). Pointers in section 4.

## 1. State at a glance

- The platform already owns the strategy *evaluation* gauntlet
  (backtester -> held-out -> walk-forward -> QFA-611 deflated gate). The
  workstream adds the missing *generation* layer in front of it.
- The architecture is **approved directionally** by review.
- It is **NOT implementation-ready.** Two P1 wiring gaps and one P2
  mapping gap must be closed by a reviewed contract first (SCOPE-01),
  before any generator/loop code (IMPL-01).
- SCOPE-01 has been **drafted locally but not yet committed/pushed**; it
  exists only on the local machine right now (section 3).
- PR #362 carries the design + review docs and is open for human review;
  there is no CI signal on the branch (section 8).

## 2. Environment topology (read this first)

There are two distinct environments, and the boundary matters:

- **Local machine** (where you, the secondary coordinator, work):
  `D:\Quant-futures-app` repo working copy plus the `D:\qfa-cache` data
  lake (Databento DBN archives + derived Parquet cache). Only here can
  anyone read `D:\qfa-cache` or run the backtester against real data.
- **Cloud session** (where the prior assistant worked): an isolated
  fresh clone with **no D: drive** and, in this instance, **no executing
  GitHub Actions**. It can edit/commit/push repo files and drive GitHub,
  but cannot see local-only files or the data lake.

Consequence: files created locally are invisible to the cloud session
until committed and pushed. The SCOPE-01 files (section 3) are currently
in exactly that state — local-only.

## 3. Immediate action required

The SCOPE-01 deliverable was authored on the local machine:

- `docs/research/strategy-gen-candidate-registry-and-trial-accounting-scope-01.md`
- `docs/plan/new_app_v1_ticket_backlog_v6.csv` (backlog row added)

As of this handoff these are **uncommitted and unpushed**; the remote
branch `claude/strategy-engine-qfa-cache-112aa3` is at `add5dea`, which
does not contain them. No validation, staging, commit, push, or PR has
been performed for them.

First task for the coordinator:

1. Review the two local files.
2. Decide placement: append to **PR #362**, or open a **separate PR**
   (recommended, since SCOPE-01 also edits the backlog CSV and is the
   gating contract rather than the proposal). This decision is still
   open.
3. Commit and push. If a separate PR, branch from the current branch or
   `main` per your convention; note the repo's stated rule is to develop
   on `claude/strategy-engine-qfa-cache-112aa3` unless given explicit
   permission to use another branch.
4. After push, verify the contract lines up with the repo facts in
   section 6.

## 4. Artifact inventory

Committed on branch `claude/strategy-engine-qfa-cache-112aa3` (PR #362,
head `add5dea`, 3 commits, 2 files, +708):

- `docs/research/strategy-generation-loop-design-01.md` — normative
  design spec for the loop (Status: Proposed).
- `docs/research/strategy-generation-loop-review-01.md` — second-review
  packet; section 12 records the folded audit findings.

Local-only (not yet in any commit):

- `docs/research/strategy-gen-candidate-registry-and-trial-accounting-scope-01.md`
- `docs/plan/new_app_v1_ticket_backlog_v6.csv` (modified)

This handoff:

- `docs/research/strategy-gen-coordinator-handoff-01.md` (this file).

## 5. The design in one page

- **Loop:** generate -> test (TRAIN) -> score S (VALIDATION) -> select +
  read failures -> refine, then survivors pass once through the QFA-611
  gate on SEALED held-out, then paper -> shadow -> broker.
- **Data-split spine:** TRAIN / VALIDATION / sealed HELD-OUT / paper. The
  loop spins only in TRAIN+VALIDATION; held-out is touched once per
  candidate by QFA-611 only.
- **Two scoring functions:** a cheap in-loop `S`
  (HAC-Sharpe-anchored + profit factor + expectancy - drawdown -
  fold-Sharpe dispersion - trade-count softfloor) for ranking, vs. the
  strict, once-per-candidate QFA-611 verdict for the gate. The
  asymmetry is deliberate; optimizing directly on the strict gate would
  overfit to the gate.
- **Objective choice:** IC/ICIR (from the external "loop engineering"
  source) is rejected as the objective — it is cross-sectional factor
  machinery, wrong for single-instrument intraday MNQ. Half-life is kept
  as a diagnostic, not a gate.
- **Per-family search schema:** numeric dims with mandatory grid `step`
  (finite, countable trials); constraint-invalid candidates are not
  trials. Worked for `regime_shock_reversion_short` (regime thresholds),
  `trend_pullback` (paired bands + structure-anchored targets), and
  `liquidity_sweep_reversal` (generation-INELIGIBLE under CF-30).
- **Honesty invariants:** every scored candidate deflates the gate
  (`effective_trial_count`); held-out stays sealed; gate runs once per
  candidate; parameter lock precedes the gate; ineligible families are
  refused before sampling.

## 6. Repo facts the contract must respect (verified)

These were verified against the codebase and are the ground truth the
SCOPE-01 contract and IMPL-01 code must honor:

- Candidate ids are not registered: `CANDIDATE_STRATEGY_IDS = []` in
  `apps/strategy_runtime/src/contracts/strategy-ids.ts`;
  `apps/strategy_runtime/src/strategies/registry.ts`
  `STRATEGY_GENERATORS` maps only static `StrategyId`s; `parseStrategyId`
  throws on unknown ids.
- QFA-611's default roster reads only `ACTIVE_STRATEGY_IDS`
  (`scripts/strategy-selection/qfa-611-strategy-selection.py`
  `active_strategy_ids()`), but `build_selection` already honors
  `--strategy-ids` when provided.
- Trial accounting is NOT wired: QFA-611 sets
  `effective_trial_count = max(len(roster), len(locks))` and emits it
  directly; it does not call the helper. The helper to use is
  `scripts/strategy-selection/_lib/effective_trials.py`
  `compute_effective_trial_count(manual_declared_effective_trials,
  distinct_window_fingerprint_tuples, effective_trial_method)`.
- Gate thresholds (must not be relaxed):
  `scripts/strategy-selection/_lib/thresholds.py` — PF 1.35, total-trades
  floor 300, drawdown gate 0.08, per-regime floor 30.
- CF-30 retirement is real and runtime-enforced:
  `config/strategies/liquidity_sweep_reversal_*.yaml` carry
  `pre_committed_retirement: true` and a do-not-retune warning;
  `liquidity_sweep_reversal_common.ts`
  `validateLiquiditySweepParameters` throws unless it is true.
- Trend-pullback targets are structure-anchored:
  `apps/strategy_runtime/src/strategies/trend_pullback_long.ts`
  `choch_sell ?? nearest_resistance`, RR only as fallback.
- Data lake roots: default Parquet cache `D:/qfa-cache/parquet`
  (override `QFA_PARQUET_CACHE_ROOT`,
  `apps/strategy_runtime/src/data/parquet-cache.ts`); raw Databento
  archive e.g. `D:/qfa-cache/databento/tier-a-feb-mar-2026`
  (`scripts/backtester/qfa-402b-mbp-trades-proxy-smoke.mts`).

## 7. SCOPE-01 contract — what it must pin (and the IMPL-01 gate)

SCOPE-01 (the local draft) is the reviewed contract that must exist
before loop code. It should define, at minimum:

1. **Candidate registry contract** — candidate ids are a build artifact,
   never hand-edited. Either a typegen step regenerating `strategy-ids.ts`
   + `registry.ts` (each candidate id -> its family generator), or a
   manifest consumed via `--strategy-ids`. Must be **fail-closed**: an
   unregistered/mismatched candidate id aborts, never silently runs.
2. **Candidate manifest shape** — candidate id -> family generator +
   config hash (parameter lock), so the gated artifact provably equals
   the emitted config.
3. **QFA-611 `--trial-accounting-manifest` contract** — carries
   `manual_declared_effective_trials = trial_budget` (count of candidates
   actually scored, not survivors), routed through
   `compute_effective_trial_count(...)` with
   `effective_trial_method="max_of_manual_and_distinct_fingerprints"`.
   **Fail-closed** on missing/mismatched trial accounting.
4. **Per-family corpus declaration** — each `search.yaml` names the
   required corpus surface (raw Databento archive vs Parquet cache vs
   OHLCV/RTH series); loader rejects a family whose features are absent
   from the declared surface.

Definition of done before IMPL-01: items 1-4 reviewed and merged. The
follow-on ticket is
`STRATEGY-GEN-CANDIDATE-REGISTRY-AND-TRIAL-ACCOUNTING-IMPL-01`, which
builds the wiring the contract specifies. **Do not write the
generator/backtest loop until SCOPE-01 is merged** — that ordering is the
guardrail that prevents a fast overfitting machine.

## 8. CI and process notes

- `.github/workflows/ci.yml` triggers on `pull_request` (no path filter)
  and runs lint, TS build, unit tests, Python syntax check, and a
  determinism replay gate.
- Despite that, PR #362's head reports **zero check runs** — there is no
  CI signal on this branch in the current setup. Treat the merge of #362
  as a human-review decision, not a CI-gated one, unless branch
  protection must be satisfied. If CI must run, investigate the runner /
  Actions enablement (the workflow config itself looks correct).
- When SCOPE-01/IMPL-01 land, run the relevant checks locally
  (`npm run lint`, `npm run build`, `npm test`, `npm run check:python`,
  `npm run check:determinism`) since branch CI cannot be relied on.

## 9. Open decisions

1. SCOPE-01 placement: append to PR #362 vs separate PR (recommend
   separate).
2. Candidate registration mechanism: typegen vs manifest+`--strategy-ids`
   (or both, with a consistency check).
3. In-loop `S` weights and whether `fold_sharpe_dispersion` is the right
   consistency proxy.
4. Default sampler for IMPL-01 Tier 1 (grid for auditability vs GA/Bayes
   for reach).
5. Whether to promote the accepted design to an ADR (it touches
   ADR-0016 alpha methodology and CF-30 governance).

## 10. Binding constraints

- ADR-0016 (QFA-611 alpha decision) and ADR-0010 (validation gate) are
  binding inputs; the gate is reused, never relaxed.
- CF-30 anti-tuning discipline is binding; ineligible families
  (`pre_committed_retirement: true`) must be refused by the generator
  before sampling.
- Honesty invariants (section 5) are non-negotiable; R1 (trial
  undercount) and R2 (held-out leakage) are the critical risks the
  contract exists to close.

## 11. Source map

- Specs: `docs/research/strategy-generation-loop-design-01.md`,
  `docs/research/strategy-generation-loop-review-01.md`, and the local
  `docs/research/strategy-gen-candidate-registry-and-trial-accounting-scope-01.md`.
- Gate: `scripts/strategy-selection/qfa-611-strategy-selection.py`,
  `scripts/strategy-selection/_lib/` (psr_dsr, hac_sharpe,
  effective_trials, parameter_lock, walk_forward_loader, thresholds).
- Gate methodology: `docs/research/qfa-611-alpha-decision-research.md`,
  `docs/adr/ADR-0016-qfa-611-alpha-decision-criteria.md`.
- Runtime: `apps/strategy_runtime/src/strategies/` (generators,
  registry), `apps/strategy_runtime/src/contracts/strategy-ids.ts`,
  `apps/strategy_runtime/src/data/parquet-cache.ts`.
- Families: `config/strategies/`.
- Feature surface: `docs/data/DATA-04-MICROSTRUCTURE-FEATURES.md`.
- Backlog: `docs/plan/new_app_v1_ticket_backlog_v6.csv`.
