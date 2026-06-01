# Coordinator Handoff — 2026-05-24

This document transfers coordinator context from the retiring session to the incoming
coordinator. It is self-contained: everything needed to resume work is here. Do not
assume any session memory from prior conversations.

---

## 1. What this project is

**Quant-futures-app** is a MNQ (micro Nasdaq) futures alpha-validation platform. It is
a deterministic backtester and strategy-selection pipeline built from scratch (greenfield
repo). It is NOT a live trading system yet.

Core architecture:
- **Strategy runtime** (`apps/strategy_runtime/`) — stateless generator functions, position
  manager FSM, management profiles, regime substrate evaluation.
- **Backtester** (`apps/backtester/`) — real-archive execution runner that replays Databento
  MBO data through strategy generators + management engine.
- **Config layer** (`config/strategies/*.yaml`) — one YAML per strategy_id. Parameter locks
  are hashes of these files.
- **Artifact layer** (`artifacts/`) — held-out-validation JSONs, strategy-selection JSONs,
  fingerprint outputs. These are the audit chain.
- **Docs / ADRs** (`docs/adr/`, `docs/research/`, `docs/plan/`) — all decisions and research
  are committed here. The ADR and carry-forward system is the governance backbone.

The project has completed three validation cycles (Cycle1, Cycle2, Cycle3). Cycle3 produced
three ACTIVE strategies. Cycle4 is now in progress as REGISTERED_INACTIVE research
(pre-paper-observation, B-full scope per the closure-memo amendment).

---

## 2. Current production state (as of 2026-05-24)

### Active strategies (in live pipeline)

| strategy_id | Phase | Verdict |
|---|---|---|
| `vwap_overnight_reversal_long` | Phase 5 ADVANCE_TO_PAPER | Active |
| `vwap_overnight_reversal_short` | Phase 5 ADVANCE_TO_PAPER | Active |
| `regime_shock_reversion_short_v2` | Phase 5 ADVANCE_TO_PAPER | Active (primary focus) |

All three are defined in `apps/strategy_runtime/src/contracts/strategy-ids.ts:ACTIVE_STRATEGY_IDS`.

### Registered-inactive strategies (fully coded, NOT in pipeline)

`regime_shock_reversion_short_v3` — Cycle4 hypothesis, VIX-percentile gate added on top of v2.
YAML at `config/strategies/regime_shock_reversion_short_v3.yaml`. Code at
`apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v3.ts`. Awaiting
paper-observation data under `regime_shock_reversion_short_v2` before any promotion.
All earlier Cycle1/Cycle2 strategies are also REGISTERED_INACTIVE.

### Paper trading

`regime_shock_reversion_short_v2` is the paper-observation candidate. The paper-observation
floor is **≥45-60 trading days** (CF-52). Broker integration work (QFA-612-BROKER-03) has
not been dispatched yet — it was unblocked by the Cycle3 re-derivation (PR #217) but no
packet has been written. The operator must authorize timing.

---

## 3. Recent commit history (last 12 PRs to main)

| PR | Commit | Subject |
|---|---|---|
| #233 | b6b184d | MOC-R4: build hit-curve + expectancy heatmaps |
| #232 | 8951332 | CYCLE4-V3-IMPL: regime_shock_reversion_short_v3 as REGISTERED_INACTIVE |
| #231 | 11110fc | MOC-R3: build trigger-conditional simulator |
| #230 | 71189ed | CYCLE4-S1: add vix_prior_close_percentile to snapshot context |
| #228 | 1b051cc | docs: amend Cycle3 closure-memo Cycle4 deferral scope (B-full) |
| #229 | 5b79043 | MOC-R2: build per-event price-path extractor |
| #227 | d58cf3d | docs: add Cycle4 hash lineage trace memo |
| #223 | 4ec0377 | BACKLOG: add CYCLE4-R1 + CYCLE4-R2 backlog rows |
| #226 | 503cefb | CYCLE4-R1: regime_shock_reversion_short_v3 VIX-gate scoping memo |
| #225 | 65f02a6 | CYCLE4-R2: hold-time entry gate research memo (errata: PR #234) |
| #217 | ffeea42 | QFA-611-CYCLE3-REDERIVATION-01: re-run Cycle3 inference |
| #215 | 86dc5ec | QFA-MGMT-BUG-FIX-01: fix BE@PT1 combined-bar touch handling |

The CYCLE4-R2 memo was amended by PR #234 (errata: v4-delay incorrectly said "No new feature
substrate fields required" — corrected). PR #234 should be confirmed merged; verify with
`git log origin/main --oneline -3` before relying on it.

---

## 4. Governance framework

### ADRs (in `docs/adr/`)

The project has a strict ADR system. Key ADRs for the incoming coordinator:

| ADR | Subject | Why it matters |
|---|---|---|
| ADR-0013 | Regime substrate methodology | Frozen. Do NOT modify regime classification logic without a new ADR. |
| ADR-0016 | Alpha decision criteria | Sets the 9 Phase-5 thresholds (Sharpe, DSR, PSR, PF, etc.). Cannot be revised without external methodological justification (CF-45). |
| ADR-0022 | Regime-conditional entry/exit gating | Entry and exit gates must respect regime labels per this ADR. |
| ADR-0023 | Cycle3 SignedShockMeasurement + anti-pattern lock | Frozen. DO NOT modify signed_shock canonical fields. Anti-pattern #4 (fail-closed on missing features) is load-bearing. |
| ADR-0024 | Post-verdict bug re-derivation protocol | Defines when/how to re-derive verdicts after shared-infrastructure bugs. Joint coordinator+operator sign-off required. |
| **ADR-0025** | **Stateful producer feature-memory manifest** | **PENDING — not written. This is the next ADR to draft.** See §7 below. |

### Carry-forwards (anti-tuning rules)

These are non-negotiable. The incoming coordinator must not approve any work that violates them.

| CF | Rule |
|---|---|
| **CF-30** | No parameter tune on a locked YAML without a new ADR. |
| **CF-41** | New hypothesis = new strategy_id. Never re-fit an existing strategy_id with different parameters. |
| **CF-44** | No near-miss tuning. If a strategy almost passes, that is not license to adjust parameters. |
| **CF-45** | Threshold revisions (ADR-0016) require external methodological justification. No internal justification suffices. |
| **CF-52** | Paper observation floor: ≥45-60 trading sessions before any live-promotion decision. The clock starts when paper trading actually begins. |

### LD-023 anti-patterns (from ADR-0023)

All strategies must fail-closed on missing context fields (anti-pattern #4). If a required
feature (e.g., `vix_prior_close_percentile`) is `null` or non-finite, the strategy must
return an explicit blocked rejection reason, NOT silently fall through to evaluate on
stale/default data.

Pattern in v3: `if (vixPct === null || !Number.isFinite(vixPct)) return 'regime_shock_reversion_short_v3:vix_percentile_unavailable';`

---

## 5. Critical architecture notes

### Determinism / hash chain

The platform maintains byte-equal determinism across runs. Three hash levels:
- `strategy_fingerprint_sha256` — per-strategy decisions only.
- `final_phase2_hash` — over `PHASE2_DETERMINISM_STRATEGY_IDS`.
- `final_phase4_hash` — over regime substrate only.

**Before and after any schema PR**, run `check-determinism.mts`. The hashes must be byte-equal.
If a schema change does NOT affect strategy decision logic, hashes will not change (this was
verified in the B-full amendment trace memo, PR #227).

### Compile check for CI

`tsc --noEmit` does NOT catch cross-workspace type errors. The CI-equivalent command is:
```
tsc -b tsconfig.json
```
Always run this before opening a PR. A worker missed this on PR #232 (CYCLE4-V3-IMPL) and
the CI failed on a missing `STRATEGY_CONFIG_PATHS` entry.

### Strategy generator contract

Strategy generators are **stateless-by-design**. They receive a single `StrategyFeatureSnapshotContext` and return either a signal or a rejection string. They do NOT have access to prior bars' decisions, prior bar prices, or any mutable state.

This is why ADR-0025 is needed: the Cycle4-R2 v4-delay and v4-persist hypotheses both need
state across snapshot evaluations ("when did shock first arm?", "how many consecutive bars?").
The platform has no mechanism for this today.

### Position manager FSM (post-fix)

The FSM in `apps/strategy_runtime/src/management/position-manager/index.ts` now evaluates
in this order (bug-fixed as of PR #215):
```
fail_safe → targets → stop_hit → time_stop → break_even arm → trailing
```

Before the fix, `stop_hit` ran before `targets`, causing PT1 partials to be silently cancelled
on same-bar cases. This was the "BE@PT1 combined-bar bug". The fix added a `pt1_touched` flag
set in a pre-stop pass; BE arms on touch (not fill). This is now covered by unit tests at
`apps/strategy_runtime/tests/unit/position-manager.test.ts`.

### Kelly sizing

Post-fix Cycle3 analysis (SIZING-R1, `docs/research/sizing-r1-post-fix-kelly-tiered-rederivation.md`):
- Classic binary Kelly: **14.92%** (ignores variance — NOT the correct reference)
- Generalized log-utility Kelly: **7.89%** (accounts for variance — the correct sizing reference)

Use the generalized Kelly number for any sizing decisions. The divergence exists because
BE-saves raise win rate but also raise variance (Std[R] +25.4%).

---

## 6. Cycle4 research chain

### What the B-full scope allows (PR #228 amendment to Cycle3 closure memo)

The Cycle3 closure-memo amendment permits Cycle4 work in four categories without constituting
a formal new cycle:
1. Research memos (no code)
2. Backlog rows
3. Schema PRs — with **byte-equal regression gate**
4. REGISTERED_INACTIVE implementations (full code + tests, not in active pipeline)

Cycle4 hypotheses cannot go ACTIVE until a formal Cycle4 cycle runs (with held-out validation,
ADR-0016 thresholds, etc.).

### Cycle4 work done

| Item | PR | Status |
|---|---|---|
| CYCLE4-R1: VIX-gate scoping memo | #226 | Merged |
| CYCLE4-R2: Hold-time entry gate memo | #225 + #234 errata | Merged |
| Cycle4 hash lineage trace | #227 | Merged |
| CYCLE4-S1: `vix_prior_close_percentile` schema field | #230 | Merged |
| CYCLE4-V3-IMPL: v3 strategy REGISTERED_INACTIVE | #232 | Merged |
| MOC-R1 through MOC-R4: simulation tooling | #222, #224, #229, #231, #233 | Merged |

### Cycle4 work pending

See §7 for the prioritized queue.

---

## 7. Open work — prioritized queue

### Priority 1: ADR-0025 (IMMEDIATE — branch exists, file not written)

**Branch**: `adr-0025-stateful-producer-feature-memory` (local only, no content committed)

**Purpose**: Authorize a stateful snapshot producer with a declarative feature-memory manifest.
This is a prerequisite for implementing Cycle4-R2 hypotheses (v4-delay, v4-persist).

**Scope of the ADR**:

The operator's concrete proposal (from the session before compaction):
- Add `feature_event_state: Map<string, FeatureEventState>` to `SnapshotContextState` (producer-side, mutable).
- Surface read-only `feature_memory` on `StrategyFeatureSnapshotContext` (what strategies see).
- Declare which features get which memory primitives in a manifest (analogous to how the
  feature-availability-mask declares decision tiers).

Memory primitive types to authorize:
- `counter` — integer that increments/resets on defined conditions.
- `last-armed-timestamp` — UTC ns of the most recent event that armed a state.
- `sliding-window` — rolling buffer of N prior values.
- `rolling-prune` — eviction policy for bounded memory.

Required invariants the ADR must lock:
1. **Byte-equal replay** — two seeded runs of the same archive produce byte-identical output.
   This is the load-bearing invariant for the audit chain.
2. **Fingerprint stability** — existing strategies (v2, vwap_overnight_reversal_*) must produce
   zero change in `strategy_fingerprint_sha256`. New strategies' fingerprints must correctly
   change when memory state changes.
3. **Causal cleanness** — memory state at snapshot i reflects state through bar i only. No
   look-ahead permitted.
4. **Counter-reset conditions** — must be declared in manifest (session boundary, regime
   transition, explicit invalidation). Not ad hoc in generator code.
5. **Lag exactness** — specific lag contract must be documented per memory primitive.

Five test invariants the operator specified:
- Counter-reset (session boundary, regime transition, explicit invalidation)
- Lag exactness (specific lag contract documented)
- Rolling prune (eviction policy documented)
- Replay determinism (byte-equal across two seeded runs)
- Fingerprint sensitivity (existing strategies zero-change; new strategies correctly change)

**Authority model**: Joint coordinator + operator sign-off (analogous to ADR-0024 LD-024-2).
Both must explicitly approve before merging. Document in a "Voting Record" section at the end
of the ADR.

**Template**: Follow the structure of `docs/adr/ADR-0024-post-verdict-bug-rederivation.md`:
- Status
- Context
- Locked Decisions (LD-025-1 through LD-025-N)
- What This ADR Does NOT Do
- Consequences (implementation chain table)
- Risk Register
- References
- Voting Record
- Amendments

**What ADR-0025 does NOT do**:
- Does NOT implement any strategy using feature_memory (that is CYCLE4-S2-EXTENDED).
- Does NOT change any active strategy's behavior.
- Does NOT change any fingerprint for existing strategies.
- Does NOT modify regime substrate or ADR-0013 frozen fields.

**Suggested locked decisions** (minimum — coordinator may add more):
- LD-025-1: What a "feature-memory primitive" is (definition + allowed types).
- LD-025-2: Where producer-side state lives (`SnapshotContextState.feature_event_state`).
- LD-025-3: What strategies see (read-only `feature_memory` on context).
- LD-025-4: Manifest structure and authority (who can add primitives, how).
- LD-025-5: Byte-equal replay invariant (protocol-level guarantee).
- LD-025-6: Fingerprint stability invariant (existing strategies unaffected).
- LD-025-7: Causal cleanness rule (no look-ahead in state update).
- LD-025-8: Reset/eviction conditions must be declared in manifest, not in generator code.
- LD-025-9: What ADR-0025 does NOT authorize.

After ADR-0025 merges:

### Priority 2: CYCLE4-S2-EXTENDED worker dispatch

Implement the stateful producer subsystem: `feature_event_state` on `SnapshotContextState`,
the manifest structure, and surfacing `feature_memory` on context. This is estimated at
~600-800 LOC including test pack. Dispatch as a worker packet using the canonical dispatch
prompt at `docs/plan/engineer-dispatch-prompt.md`. The packet should reference ADR-0025
locked decisions throughout.

The schema change will need the byte-equal regression gate (`check-determinism.mts`
before/after). Existing strategy fingerprints must not change.

### Priority 3: v4-COMBINED worker dispatch (after CYCLE4-S2 merges)

Implement two new REGISTERED_INACTIVE strategies:
- `regime_shock_reversion_short_v4_delay` — adds a hold-time entry gate (N consecutive
  bars of shock signal before arming).
- `regime_shock_reversion_short_v4_persist` — adds signal-persistence requirement.

Both consume `feature_memory` from the ADR-0025 subsystem. Both are REGISTERED_INACTIVE
on arrival. Both need fixture tests. Both need `run-spec-builder.ts` entries (lesson from
the CYCLE4-V3-IMPL CI failure).

### Priority 4: QFA-612-BROKER-03 (paper observation dispatch)

Paper trading integration for `regime_shock_reversion_short_v2`. This was unblocked by
the Cycle3 re-derivation (PR #217). No packet has been written. The operator needs to
authorize timing and scope. The allowed strategy_ids for paper trading are defined in the
LUCIDFLEX allowlist. Dispatch only after the operator explicitly asks.

### Priority 5: Branch cleanup (operator UI)

These remote branches are orphans (PRs merged or closed):
```
claude/quant-futures-regime-shock-XGCUb
process-01-dispatch-protocol-formalization
backlog-moc-r1-add
sizing-r1-kelly-tiered-rederivation
backlog-cycle4-r1-r2-add
cycle4-r2-hold-time-entry-gate-research
cycle4-r1-vix-gate-scope
codex/cycle4-s1-vix-prior-close-percentile
codex/cycle4-v3-impl-regime-shock-reversion-short-v3
cycle4-r2-memo-errata
adr-0025-stateful-producer-feature-memory
```

The incoming coordinator can delete these via GitHub UI or `git push origin --delete <branch>`.
Confirm each PR is merged before deleting.

---

## 8. Key source files

| File | Role |
|---|---|
| `apps/strategy_runtime/src/contracts/strategy-ids.ts` | `ACTIVE_STRATEGY_IDS`, `REGISTERED_INACTIVE_STRATEGY_IDS`, `StrategyId` type |
| `apps/strategy_runtime/src/strategies/types.ts` | `StrategyFeatureSnapshotContext`, `StrategyRegistryEntry`, `StrategyFixtureId` |
| `apps/strategy_runtime/src/config/strategy-config.ts` | Per-strategy parameter interfaces + defaults + ranking priority |
| `apps/strategy_runtime/src/management/position-manager/index.ts` | FSM evaluation order (post-fix: targets → stop, not stop → targets) |
| `apps/strategy_runtime/src/management/stops.ts` | `evaluateStopHit`, `closePosition` (cancels pending targets) |
| `apps/strategy_runtime/src/management/targets.ts` | `applyTargetHits` |
| `apps/strategy_runtime/src/management/management-profiles.ts` | `BASE_BREAK_EVEN` profile (`trigger: 'after_pt1', offset_ticks: 1`) |
| `apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts` | `loadRegimeLabels` — populates `vix_prior_close_percentile` from archive |
| `apps/backtester/src/run-spec-builder.ts` | `STRATEGY_CONFIG_PATHS` — must have entry for every `StrategyId` |
| `config/strategies/regime_shock_reversion_short_v2.yaml` | v2 parameter lock (DO NOT modify) |
| `config/strategies/regime_shock_reversion_short_v3.yaml` | v3 parameter lock + VIX gate bounds |
| `apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v3.ts` | v3 generator — VIX gate at `[0.67, 0.85)` |
| `docs/plan/engineer-dispatch-prompt.md` | Canonical worker dispatch prompt (use this for all worker sessions) |
| `docs/adr/ADR-0024-post-verdict-bug-rederivation.md` | Template for ADR-0025 structure |
| `docs/research/qfa-611-cycle3-closure-memo.md` | Cycle3 closure — B-full amendment at bottom |
| `docs/research/cycle4-r1-regime-shock-v3-vix-gate-scope.md` | VIX gate boundary analysis (0.67-0.85 over-fire zone) |
| `docs/research/cycle4-r2-hold-time-entry-gate.md` | Hold-time research + errata (requires stateful producer) |
| `docs/research/sizing-r1-post-fix-kelly-tiered-rederivation.md` | Kelly analysis — use generalized Kelly 7.89% |

---

## 9. Dispatch protocol

**Always use the canonical dispatch prompt** at `docs/plan/engineer-dispatch-prompt.md` when
dispatching worker sessions. The prompt includes:
- Parameterized `REPO_ROOT`
- Correct backlog filename (`new_app_v1_ticket_backlog_v6.csv`)
- Branch naming conventions for FleetView environments
- §3 Step 8 coordinator review gate (worker sets `STATE: PENDING-REVIEW` before opening PR)
- The coordinator reviews the diff before the PR goes from PENDING-REVIEW to READY-FOR-PR

**Worker pattern for PRs**:
1. Worker opens a DRAFT PR.
2. Worker sets `STATE: PENDING-REVIEW`.
3. Coordinator reviews diff (not just PR description).
4. Coordinator approves → worker upgrades to READY-FOR-PR or marks ready for review.
5. Operator merges.

**Never skip the coordinator review gate.** The CYCLE4-V3-IMPL CI failure (PR #232) was
caught during coordinator review — a cross-workspace type error that `tsc --noEmit` misses.

---

## 10. Strategy v2 performance reference

Post-fix (BE@PT1 bug corrected), Cycle3 held-out validation:

| Metric | Pre-fix | Post-fix |
|---|---|---|
| Profit Factor | 1.40 | 2.17 |
| Win Rate | ~48% | ~50.6% |
| Sharpe | — | Improved materially |
| Paper verdict | ADVANCE_TO_PAPER | Confirmed |

528 total trades in Cycle3 corpus. The Apr 1-8 window (worst window) was the regime-pinning
case — the high-vol regime classifier sustained a "high" classification through directional
trends, producing MFE/MAE collapse. This is documented as a Cycle4 research finding (NOT a
re-derivation trigger), and the VIX gate in v3 is the primary mitigation.

VIX gate analysis (CYCLE4-R1):
- Calm (0-33th pct): Profitable (PF > 1.0)
- Elevated (67-85th pct): Over-fire zone (PF 0.934) — BLOCKED by v3 gate
- Extreme (>85th pct): Profitable (PF > 1.0)
- Gate: `[0.67, 0.85)` — inclusive lower, exclusive upper

---

## 11. What the retiring coordinator did NOT complete

1. **ADR-0025** — branch `adr-0025-stateful-producer-feature-memory` was created but the
   document was never written. The operator confirmed Path A (ADR-first). This is the most
   urgent pending item.

2. **CYCLE4-R2 errata PR #234** — opened before compaction; confirm merged via
   `git log origin/main --oneline -3`.

3. **QFA-612-BROKER-03 dispatch packet** — not drafted. Awaiting operator authorization.

4. **MOC-R5 through MOC-R7** — the Plan A research stack extends to R7. R1-R4 are done (#222,
   #224, #229, #231, #233). R5+ have not been discussed.

---

## 12. Verification checklist for the incoming coordinator

Run these on first session to confirm clean state:

```bash
# 1. Confirm main is at expected HEAD
git log origin/main --oneline -3

# 2. Check no uncommitted changes
git status

# 3. Verify current active strategy IDs
cat apps/strategy_runtime/src/contracts/strategy-ids.ts

# 4. Confirm v3 is REGISTERED_INACTIVE (not ACTIVE)
grep -n "regime_shock_reversion_short_v3" apps/strategy_runtime/src/contracts/strategy-ids.ts

# 5. Verify vix_prior_close_percentile exists on context
grep -n "vix_prior_close_percentile" apps/strategy_runtime/src/strategies/types.ts

# 6. Confirm no open PRs
# (use GitHub MCP: mcp__github__list_pull_requests owner=neeljaiswal90 repo=quant-futures-app state=open)

# 7. CI-equivalent compile check
tsc -b tsconfig.json --noEmit
```

---

## 13. Immediate first action

Draft `docs/adr/ADR-0025-stateful-producer-feature-memory.md` on branch
`adr-0025-stateful-producer-feature-memory`. Use `docs/adr/ADR-0024-post-verdict-bug-rederivation.md`
as the structural template. The ADR must lock at minimum LD-025-1 through LD-025-9 as specified
in §7. Get joint coordinator + operator sign-off before merging. Open as a DRAFT PR.

After ADR-0025 is merged: dispatch CYCLE4-S2-EXTENDED (stateful producer implementation),
then dispatch v4-COMBINED (v4-delay + v4-persist as REGISTERED_INACTIVE).
