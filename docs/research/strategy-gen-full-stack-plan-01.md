# Strategy Generation Full Stack Plan 01

## Purpose

This plan captures the full build-out for the strategy generation loop from current foundation fixes through cost-true backtesting, cumulative trial accounting, TRAIN/VALIDATION optimization, sealed held-out gating, advisory proposal generation, adaptive search, and human-gated promotion.

The immediate objective is not to create paper, broker, roster, or Phase 6 authority. The loop remains research and governance infrastructure until separate promotion tickets authorize downstream action.

## Guiding constraints

- Contract before code: any capability with material wiring gets a reviewed `SCOPE-01` before `IMPL-01`.
- Count everything: every data-touching evaluation feeds a cumulative `effective_trial_count`; adaptive search gets an additional haircut.
- Seal held-out: automation lives in TRAIN and VALIDATION; the gate touches held-out once per candidate; validation is rotated or nested so the optimizer cannot overfit it.
- Fail closed and ungoverned: generated registry defaults empty; CF-30 eligibility refuses tuning misuse; no roster mutation and no paper or broker authority comes from the loop.
- Deterministic and cost true: byte-stable replays; commissions and spread/slippage are modeled before optimization; ADR-0016 and ADR-0010 remain binding.

## Sequencing principle

Attack edge before scaling search. Bayesian optimization and genetic algorithms can sample faster, but they do not create edge by themselves. The current family failed on profit factor before fees were modeled. Therefore the foundation and edge-improvement layers come before adaptive search.

## Phase 0 - Make the result real

Goal: produce a single-family grid run that is cost true, cumulatively deflated, determinism asserted, and CI meaningful on a clean branch.

Exit criteria:

- `regime-shock-v2-tier1` reruns with byte-stable, fee-charged, honestly deflated metrics.
- `tsc -b` and CI are meaningful on a clean substrate.
- Reports clearly distinguish gross and net metrics.

Tickets:

| Ticket | Priority | Points | Depends on | Purpose |
|---|---|---:|---|---|
| `STRATEGY-GEN-FOLD-LANDING-01` | P0 | 3 | none | Extract the entangled fold onto a clean main-based worktree with allowlisted files and fail-closed generated registry. |
| `STRATEGY-GEN-EXECUTION-COST-MODEL-SCOPE-01` | P0 | 2 | `STRATEGY-GEN-FOLD-LANDING-01` | Define commission schedule, spread and slippage semantics, gross versus net PnL, and MNQ per-contract fee handling. |
| `STRATEGY-GEN-EXECUTION-COST-MODEL-IMPL-01` | P0 | 5 | `STRATEGY-GEN-EXECUTION-COST-MODEL-SCOPE-01` | Charge commissions and modeled costs in replay and fail if net equals gross when fees are configured. |
| `STRATEGY-GEN-CUMULATIVE-TRIAL-LEDGER-SCOPE-01` | P1 | 2 | none | Define persistent cross-run trial accounting per family and substrate. |
| `STRATEGY-GEN-CUMULATIVE-TRIAL-LEDGER-IMPL-01` | P1 | 5 | `STRATEGY-GEN-CUMULATIVE-TRIAL-LEDGER-SCOPE-01` + `STRATEGY-GEN-EXECUTION-COST-MODEL-IMPL-01` | Append to the ledger and make QFA-611 deflate against cumulative effective trials. |
| `STRATEGY-GEN-DETERMINISM-ASSERTION-IMPL-01` | P1 | 2 | `STRATEGY-GEN-FOLD-LANDING-01` | Run held-out twice and assert byte-identical hashes in the report. |
| `STRATEGY-GEN-REPORT-HARDENING-IMPL-01` | P1 | 2 | `STRATEGY-GEN-EXECUTION-COST-MODEL-IMPL-01` + `STRATEGY-GEN-CUMULATIVE-TRIAL-LEDGER-IMPL-01` + `STRATEGY-GEN-DETERMINISM-ASSERTION-IMPL-01` | Report net-of-fees metrics, cumulative DSR, HAC-t, determinism, and remove unsupported economic gloss. Determinism is a hard Phase 0 exit gate. |

## Phase 1 - Build the actual loop

Goal: implement the TRAIN/VALIDATION inner loop so generation does not go straight to held-out gating.

Exit criteria:

- Generate candidates.
- Score on TRAIN/VALIDATION only.
- Select survivors.
- Send only survivors to the gate once.

Tickets:

| Ticket | Priority | Points | Depends on | Purpose |
|---|---|---:|---|---|
| `STRATEGY-GEN-DATA-SPLIT-SPINE-SCOPE-01` | P1 | 2 | `STRATEGY-GEN-REPORT-HARDENING-IMPL-01` | Define TRAIN, VALIDATION, sealed HELD-OUT, and paper partitions. |
| `STRATEGY-GEN-DATA-SPLIT-SPINE-IMPL-01` | P1 | 5 | `STRATEGY-GEN-DATA-SPLIT-SPINE-SCOPE-01` | Implement partitioned loaders and fail-closed held-out access guards. |
| `STRATEGY-GEN-INLOOP-S-SCORE-SCOPE-01` | P1 | 2 | `STRATEGY-GEN-DATA-SPLIT-SPINE-SCOPE-01` | Define the in-loop score from HAC-Sharpe, PF, expectancy, drawdown, fold dispersion, and trade floor penalties. |
| `STRATEGY-GEN-INLOOP-S-SCORE-IMPL-01` | P1 | 5 | `STRATEGY-GEN-INLOOP-S-SCORE-SCOPE-01` | Compute deterministic TRAIN/VALIDATION score without reading held-out. |
| `STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01` | P1 | 5 | `STRATEGY-GEN-INLOOP-S-SCORE-IMPL-01` + `STRATEGY-GEN-DATA-SPLIT-SPINE-IMPL-01` | Wire generate to score to select to refine to gate-once in `run-tier1-loop`. |
| `STRATEGY-GEN-VALIDATION-HYGIENE-NESTED-CV-IMPL-01` | P1 | 5 | `STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01` | Add rotated or nested validation so optimization cannot overfit one validation fold. |

## Phase 2 - Attack edge and add advisory proposals

Goal: raise the candidate ceiling with meta-labeling and feature/spec proposal support before scaling search.

Exit criteria:

- Either a candidate clears cost-true PF on held-out or the family receives a defensible sub-cost verdict.
- Advisory LLM outputs remain inert proposals until reviewed.

Tickets:

| Ticket | Priority | Points | Depends on | Purpose |
|---|---|---:|---|---|
| `STRATEGY-GEN-META-LABELING-SCOPE-01` | P1 | 3 | `STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01` | Define secondary model gating for primary signals with leakage controls. |
| `STRATEGY-GEN-META-LABELING-IMPL-01` | P1 | 8 | `STRATEGY-GEN-META-LABELING-SCOPE-01` | Implement walk-forward meta-labeling and count all evaluations as search trials. |
| `STRATEGY-GEN-FEATURE-DISCOVERY-IMPL-01` | P2 | 5 | `STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01` | Use feature importance to propose new reviewed dimensions and features. |
| `STRATEGY-GEN-LLM-ADVISORY-SIDECAR-SCOPE-01` | P2 | 2 | none | Define a read-only local advisory sidecar that produces inert proposals only; no held-out, lock, or roster access. |
| `STRATEGY-GEN-LLM-ADVISORY-SIDECAR-IMPL-01` | P2 | 5 | `STRATEGY-GEN-LLM-ADVISORY-SIDECAR-SCOPE-01` | Implement the read-only proposal sidecar and artifacts; read-only tools only, no held-out, lock, or roster access. |
| `STRATEGY-GEN-LLM-SPEC-DRAFTER-IMPL-01` | P2 | 3 | `STRATEGY-GEN-LLM-ADVISORY-SIDECAR-IMPL-01` | Draft reviewed `search.yaml` family and dimension proposals. |
| `STRATEGY-GEN-LLM-FAILURE-NARRATOR-IMPL-01` | P2 | 3 | `STRATEGY-GEN-LLM-ADVISORY-SIDECAR-IMPL-01` + `STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01` | Convert TRAIN/VALIDATION failure artifacts into reviewable diagnosis notes. |

## Phase 3 - Scale search after the edge surface is credible

Goal: add adaptive search behind the same trial-accounting contract.

Exit criteria:

- Adaptive search matches or beats grid with fewer evaluations.
- All evaluations and adaptive haircuts are accounted for.

Tickets:

| Ticket | Priority | Points | Depends on | Purpose |
|---|---|---:|---|---|
| `STRATEGY-GEN-SAMPLER-INTERFACE-SCOPE-01` | P1 | 2 | `STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01` | Define a pluggable sampler contract with explicit evaluation accounting. |
| `STRATEGY-GEN-SAMPLER-INTERFACE-IMPL-01` | P1 | 3 | `STRATEGY-GEN-SAMPLER-INTERFACE-SCOPE-01` | Refactor grid behind the sampler interface without behavior change. |
| `STRATEGY-GEN-ADAPTIVE-SEARCH-DEFLATION-SCOPE-01` | P2 | 2 | `STRATEGY-GEN-CUMULATIVE-TRIAL-LEDGER-IMPL-01` | Define the adaptive-search haircut for BO and GA style search. |
| `STRATEGY-GEN-BAYESIAN-SAMPLER-IMPL-01` | P2 | 8 | `STRATEGY-GEN-SAMPLER-INTERFACE-IMPL-01` + `STRATEGY-GEN-VALIDATION-HYGIENE-NESTED-CV-IMPL-01` + `STRATEGY-GEN-ADAPTIVE-SEARCH-DEFLATION-SCOPE-01` | Implement GP or TPE over the TRAIN/VALIDATION score with all evaluations counted. |
| `STRATEGY-GEN-SURROGATE-PRUNER-IMPL-01` | P2 | 5 | `STRATEGY-GEN-BAYESIAN-SAMPLER-IMPL-01` | Use a surrogate to prune low-probability candidates before expensive replay. |

## Phase 4 - Generative reach

Goal: add higher-risk structural and learned-signal search only after the core loop is honest and cost true.

Tickets:

| Ticket | Priority | Points | Depends on | Purpose |
|---|---|---:|---|---|
| `STRATEGY-GEN-GA-SAMPLER-SCOPE-01` | P3 | 3 | `STRATEGY-GEN-SAMPLER-INTERFACE-IMPL-01` | Define genetic or combinatorial search with population and generation accounting. |
| `STRATEGY-GEN-GA-SAMPLER-IMPL-01` | P3 | 8 | `STRATEGY-GEN-GA-SAMPLER-SCOPE-01` + `STRATEGY-GEN-ADAPTIVE-SEARCH-DEFLATION-SCOPE-01` | Implement GA sampling with strict deflation and trial accounting. |
| `STRATEGY-GEN-ML-SIGNAL-FAMILY-RESEARCH-01` | P3 | 13 | `STRATEGY-GEN-META-LABELING-IMPL-01` | Research ML-as-signal as a separate family with leakage and retrain discipline. |
| `STRATEGY-GEN-LLM-FAMILY-IDEATION-01` | P3 | 3 | `STRATEGY-GEN-LLM-ADVISORY-SIDECAR-IMPL-01` | Produce falsifiable mechanism-first family proposals with CF-30 eligibility checks. |

## Phase 5 - Promotion and governance

Goal: allow a gate-passing candidate to enter the existing acceptance path without shortcutting paper, shadow, broker, roster, or Phase 6 controls.

Tickets:

| Ticket | Priority | Points | Depends on | Purpose |
|---|---|---:|---|---|
| `STRATEGY-GEN-PROMOTION-PATH-SCOPE-01` | P1 | 3 | `STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01` + `STRATEGY-GEN-REPORT-HARDENING-IMPL-01` | Define gate-pass to acceptance path with human approval and no direct roster mutation; gated on the hardened evidence milestone. |
| `STRATEGY-GEN-PROMOTION-PATH-IMPL-01` | P2 | 5 | `STRATEGY-GEN-PROMOTION-PATH-SCOPE-01` | Materialize passed candidates into reviewed configs and acceptance-path entries. |
| `STRATEGY-GEN-LOOP-ADR-01` | P2 | 2 | `STRATEGY-GEN-REPORT-HARDENING-IMPL-01` + `STRATEGY-GEN-LOOP-ORCHESTRATION-IMPL-01` | Promote the loop design to ADR with CF-30 and ADR-0016 linkage. |

## Critical path

`FOLD-LANDING -> COST-MODEL -> CUMULATIVE-LEDGER -> DATA-SPLIT + S-SCORE -> LOOP-ORCHESTRATION -> META-LABELING or NESTED-CV -> SAMPLER-INTERFACE -> BAYESIAN-SAMPLER`.

Phases 0 and 1 are correctness gates. Phase 2 can run partly in parallel after Phase 1. Phases 3 and 4 are efficiency and reach and should not block correctness.

## Risk register

| Risk | Severity | Guardrail |
|---|---|---|
| Uncounted optimization laundering | High | CI-failable cumulative trial ledger checks. |
| Optimizing no-fee fiction | High | Cost model is P0 and reports must be net-of-fees. |
| Held-out leakage | High | Held-out loader throws outside the gate. |
| Validation overfit | High | Nested or rotated validation folds before adaptive search. |
| Static registry blast radius | Medium | Fail-closed generated registry and `AnyStrategyId` dynamic surfaces only. |
| LLM scope creep | Medium | LLM proposals are inert artifacts and cannot touch locks or rosters. |
| CF-30 tuning misuse | Medium | CF-30 eligibility refusal remains explicit. |
| Premature promotion | High | Promotion path requires human gate and no direct roster mutation. |

## Initial backlog footprint

This plan appends 32 dependency-ordered backlog rows under the `strategy_gen_full_stack_plan` change marker.

Inherited guardrail (binds every LLM and ML ticket even where a row summary is terse): the advisory layer is read-only and emits inert proposals only. It must not read sealed held-out data, write parameter locks, or mutate the roster. A proposal becomes a trial or a config only after human review through the normal SCOPE path.
