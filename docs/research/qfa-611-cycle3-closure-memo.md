# Phase 5 Cycle3 Closure Memo - Phase 5 closes successfully

## Status

Phase 5 closed successfully. Phase 6 paper-trading dispatch AUTHORIZED.

## G4 verdict (locked in PR #189 / strategy-selection-v3.json)

Cycle3 ran 3 strategies. effective_trial_count = 3 per CF-29 + ADR-0023
LD-023-3 (independent per-cycle selection round). DSR penalty applied at
3 trials.

JSON sha256: C313CC4CB518B47485D1D32C7F03FB22F1CD90F38F8D573DB745308860441D76

| Strategy | Verdict | Sharpe | DSR | PSR_zero | Notes |
|---|---|---:|---:|---:|---|
| regime_shock_reversion_short_v2 | ADVANCE_TO_PAPER | 4.756 | 3.622 | 0.99999 | All 9 thresholds clear |
| vwap_overnight_reversal_short | REJECT | 2.328 | 0.635 | 0.932 | trade_count + hurdle + regime_trade fail |
| vwap_overnight_reversal_long | REJECT | -1.050 | -1.418 | 0.286 | 6/9 severe failures |

Summary: advance=1, reject=2, research_further=0, run_status=complete,
execution_fragility=false.

## Phase 5 closure decisions

### 1. Phase 6 paper-trading dispatch: AUTHORIZED

phase_6_dispatch_authorized=true is data-driven. regime_shock_reversion_
short_v2 is the first strategy in project history to clear the full
ADR-0016 Stage 1 inference layer. ADR-0018 walkthrough begins.

### 2. v2 advances to paper with explicit out-of-sample caveat

The in-sample Sharpe of 4.756 is exceptional. Per ADR-0016 LD-611-7,
PAPER-OBSERVATION is required before live capital. The framework
explicitly does NOT trust a single backtest result with live deployment;
the 45-60 trading day paper observation window validates persistence
out-of-sample. The 8-gate LIVE-PROMOTION review (LD-611-8) is the
further filter. LIVE-RAMP at 1->2->3 contracts (LD-611-5) gates capital
scaling.

The paper observation begins with QFA-614 (paper trading harness)
dispatch, after ADR-0018 + ADR-0020 walkthroughs, QFA-612 (Rithmic
adapter), QFA-613 (live data streaming).

### 3. Both vwap_overnight_reversal_* strategies retire from active

REJECT verdicts on the same corpus that v2 cleared. Both move to
REGISTERED_INACTIVE for Cycle4 if dispatched. The short-side strategy
showed alpha potential (Sharpe 2.33, PF 1.36, clean sensitivity) but
fires too rarely (39 trades < 300 minimum). Per CF-30/CF-41/CF-44:
no parameter tuning on the same strategy_id. Future cycle could test a
NEW strategy_id with different trigger geometry.

### 4. Cycle1+Cycle2 strategies remain REGISTERED_INACTIVE

8 strategies (4 from Cycle1 + 4 from Cycle2) stay registered but inactive.
Their verdicts and YAMLs remain byte-locked. They are not re-tested in
Cycle3 or any future cycle without a new strategy_id and new parameter
lock per CF-41/LD-023-2.

### 5. Cycle4 dispatch: SCOPED DEFERRAL (amended 2026-05-24)

#### Original deferral language (preserved for audit lineage)

> *"Phase 5 closes successfully with one ADVANCE_TO_PAPER. The Cycle4
> decision (further hypothesis families, e.g., reversal at opening range
> failure, microstructure-derived families, event-day filters) is
> deferred until PAPER-OBSERVATION on v2 completes. If paper observation
> validates v2's alpha, Cycle4 is non-urgent; if paper observation
> reveals issues, Cycle4 dispatch becomes the primary research path."*

#### Amendment grounding

This amendment scopes the original "Cycle4 dispatch: DEFERRED" clause.
External grounding: the Apr 1-8 2026 regime-pinning finding identified
in the ADR-0024 invocation memo (commit `77ac31e`, dated ~3 hours
before the original closure memo was drafted) flagged Cycle4 research
as a candidate research path. The original closure memo's "Cycle4
deferred" language was drafted without explicit knowledge of that
finding's downstream implications. This amendment clarifies the scope
of the deferral given the now-completed CYCLE4-R1 and CYCLE4-R2
research-tier evidence packs (PRs #226 and #225, commits `503cefb`
and `65f02a6`).

The amendment is structurally supported by the CYCLE4 hash-lineage
trace at `docs/research/cycle4-hash-lineage-trace.md` (commit
`d58cf3d`, PR #227), which documents that the QFA-611 selection
pipeline's audit-chain hashes (`strategy_fingerprint_sha256`,
`final_phase2_hash`, `final_phase4_hash`) are selective in the sense
relevant for the amendment: schema additions to
`StrategyFeatureSnapshotContext` that v2 does not consume, and
REGISTERED_INACTIVE new strategy_id implementations, do not alter
v2's audit-chain hashes.

#### Scoped deferral

The Cycle4 SELECTION RUN (adding new strategy_ids to
`ACTIVE_STRATEGY_IDS`, emitting a Cycle4 lock manifest, running the
G4 gate, producing `strategy-selection-v4.json`) remains DEFERRED
until PAPER-OBSERVATION on `regime_shock_reversion_short_v2`
completes (CF-52 minimum window: ~45-60 trading days; ideally ≥6
months per SIZING-R1 deferred questions at
`docs/research/sizing-r1-post-fix-kelly-tiered-rederivation.md`).

Pre-paper-observation Cycle4 work is PERMITTED in the following
scopes:

1. **RESEARCH-TIER evidence packs** in `docs/research/cycle4-*.md` and
   `scratch/cycle4-research/`. No code paths touched. Already
   exercised: PRs #225 (CYCLE4-R2 hold-time), #226 (CYCLE4-R1
   VIX-gate scope), #227 (CYCLE4 hash-lineage trace).

2. **BACKLOG ROW additions** (`CYCLE4-*` tickets in
   `docs/plan/new_app_v1_ticket_backlog_v6.csv`). Descriptive only.
   Already exercised: PR #223 (CYCLE4-R1 + CYCLE4-R2 rows).

3. **SCHEMA PRs** (e.g., the proposed `CYCLE4-S1` to add
   `vix_prior_close_percentile` to `StrategyFeatureSnapshotContext`)
   PROVIDED they pass the standard byte-identical regression gate on
   all then-active strategies including v2. v2's outputs must be
   byte-equal pre/post schema addition. Pattern follows QFA-7xx-A
   PR #182. Hash-lineage analysis (commit `d58cf3d`) confirms that
   `strategy_fingerprint_sha256` (per-strategy decisions),
   `final_phase2_hash` (per-active-strategy artifacts), and
   `final_phase4_hash` (regime substrate inputs only) are all
   selective — schema additions that v2 does not consume do not
   alter v2's audit-chain hashes.

4. **NEW strategy_id IMPLEMENTATIONS as REGISTERED_INACTIVE**: TS
   code, YAML parameter-lock, registry entry, tests, fixtures all
   land, but the strategy_id is NOT added to `ACTIVE_STRATEGY_IDS`,
   does NOT receive a parameter-lock manifest entry in any active
   cycle, does NOT produce held-out validation artifacts, and does
   NOT appear in any selection JSON. The strategy is dormant code
   in the codebase until Cycle4 selection RUN fires
   post-paper-observation. The `REGISTERED_INACTIVE_STRATEGY_IDS`
   constant at `apps/strategy_runtime/src/contracts/strategy-ids.ts:9`
   is the canonical home for these.

#### Discipline preserved

- v2 remains the CANONICAL paper-validation candidate throughout
  the CF-52 observation window. No competing paper candidate.
- v3/v4/etc. implementations cannot displace v2 in the paper window.
- v3/v4/etc. cannot enter live execution pre-paper-observation.
- Cycle4 SELECTION decisions (which strategy_ids advance to G4)
  are made WITH the benefit of v2's paper observation evidence.

#### Anti-pattern enforcement (CF-44 + LD-611-7)

Pre-paper Cycle4 implementation work MUST NOT influence
paper-observation monitoring posture. If v2 paper observation
reveals problems, the response is honest acceptance OR a documented
retreat to NO-LIVE per LD-611-7 — NOT "luckily we already have v3
implemented; let's just swap."

Enforceable via code-level dormant state: if v2 paper observation
triggers an LD-611-7 NO-LIVE retreat, the Cycle4 SELECTION RUN
itself is also retreated. v3/v4/etc. implementations remain
permanently REGISTERED_INACTIVE until a future cycle dispatch
with proper authorization (a new closure-memo amendment, a new
ADR, or both). The pre-built implementations are not an escape
hatch — they are parallel evidence streams that exist only to
accelerate a *separate, properly-authorized* Cycle4 dispatch.

#### Authority

This amendment requires joint coordinator + operator sign-off
analogous to ADR-0024 LD-024-2. The original closure memo was a
Phase 5 decision artifact; this amendment is a scope clarification
of that artifact and follows the same authority pattern. Both
parties on record in the PR before merge.

## Open Phase 6 dispatch chain

The Cycle1-recovery governing plan §2.4 / Cycle3 governing plan §9
sequence is now active:

1. ADR-0018 walkthrough (R-Protocol integration shape; User decision)
2. ADR-0020 walkthrough (order latency SLA; User decision)
3. QFA-612 (Rithmic broker adapter; Codex implementation; ~3-6w)
4. QFA-613 (live data streaming client; Codex; ~2-4w; parallel with #3)
5. QFA-614 (paper trading harness; Codex; ~2-3w; after #3)
6. QFA-615 (live OMS + reconciliation; Codex; ~2-3w; after #3 + ADR-0020)
7. QFA-616 (kill-switch wiring; Codex; ~1-2w; after #6)
8. QFA-617 (operator console; Codex; ~1-2w; after #6)
9. QFA-618 (anomaly detection; Codex; ~1-2w; after #6 + #4)
10. QFA-619 (exchange-time discipline; Codex; ~1w; after #3)
11. ADR-0021 walkthrough (production deployment topology; User decision)
12. QFA-620 (production scaffolding; Codex; ~1w; after #11)
13. QFA-621-v2 (per-strategy live integration for regime_shock_reversion_
    short_v2 specifically; Codex; ~0.5-1w; after #5 + #6)
14. PAPER-OBSERVATION (45-60 trading day paper window per LD-611-7;
    Operational; ~9-12w; cannot be compressed)
15. LIVE-PROMOTION 8-gate review (LD-611-8; User decision)
16. LIVE-RAMP 1->2->3 contracts (LD-611-5; Operational; ~4-6w per step)

Coordinator decision required: dispatch ADR-0018 walkthrough first or
parallel with ADR-0020.

## Carry-forward additions from Cycle3 experience

- CF-52 (NEW): First-time ADVANCE_TO_PAPER strategies receive normal
  Phase 6 paper observation discipline; exceptional in-sample Sharpe
  does NOT justify compressed paper observation. The 45-60 trading day
  window per LD-611-7 is the data-grounded requirement; this number
  is not negotiable based on in-sample numbers alone. Per CF-45, only
  external methodological justification could revise this - not "the
  numbers look amazing."

## Trial accounting record

| Cycle | effective_trial_count | ADVANCE_TO_PAPER count | Phase 6 authorized? |
|---|---:|---:|---|
| Cycle1 | 4 | 0 | No |
| Cycle2 | 8 | 0 | No |
| Cycle3 | 3 | 1 | Yes (first time) |

Combined cycles: 4 + 8 + 3 = 15 strategies tested in total. 1 advanced.
Hit rate: 6.7% across all hypotheses tested. This is consistent with
the strict ADR-0016 methodology - the gate is meant to be hard.


## RE-DERIVATION AMENDMENT (2026-05-22)

This memo's original verdict table reflected the management-engine state at commit `e985b10`, which contained the BE@PT1 silent no-op defect described in ADR-0024 and the QFA-611-Cycle3 re-derivation invocation memo (commit `77ac31e`).

The re-derivation protocol per ADR-0024 LD-024-3 was executed via QFA-611-CYCLE3-REDERIVATION-01. The fixed engine from QFA-MGMT-BUG-FIX-01 (commit `86dc5ec`, implementation commit `642cf17`) was applied; the Cycle3 inference layer was re-run for all 3 strategies; new held-out validation artifacts and `strategy-selection-v3.json` were produced.

Updated verdict table from the re-derivation:

| Strategy | Before verdict | After verdict | Sharpe | DSR | PSR_zero | Trade count | PF | Verdict reason |
|---|---|---|---:|---:|---:|---:|---:|---|
| `regime_shock_reversion_short_v2` | ADVANCE_TO_PAPER | ADVANCE_TO_PAPER | 5.0541923581 | 3.7799241637 | 0.9999981956 | 571 | 1.418043 | all_stage1_thresholds_passed |
| `vwap_overnight_reversal_short` | REJECT | REJECT | 1.7589603427 | 0.1399409384 | 0.8395829864 | 40 | 1.293814 | three_or_more_stage1_thresholds_failed |
| `vwap_overnight_reversal_long` | REJECT | REJECT | -0.9601061531 | -1.3637612554 | 0.3046906677 | 69 | 0.791514 | three_or_more_stage1_thresholds_failed |

Re-derivation memo: `docs/research/qfa-611-cycle3-rederivation-memo.md`

New `strategy-selection-v3.json` sha256: `CEE1B8DCE63CFD292487721D38110B2E637646E96B3B9641BDC1B984329ABEDB`

Reconciliation decision: **Path A unchanged**. `regime_shock_reversion_short_v2` remains `ADVANCE_TO_PAPER`; `vwap_overnight_reversal_short` and `vwap_overnight_reversal_long` remain `REJECT`.

This amendment supersedes the original verdict table for all downstream dispatch authorization decisions. The original verdict table is preserved above as audit lineage; it is not the authoritative verdict from this point forward.
