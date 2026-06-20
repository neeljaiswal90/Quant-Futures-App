# Strategy-generation loop — second-review packet (01)

## Purpose and how to use this document

This is a reviewer-facing companion to the normative design proposal in
`docs/research/strategy-generation-loop-design-01.md` (referred to below
as *design-01*). It exists to make a second review tractable: it
restates the architecture self-contained, traces every load-bearing
claim back to where it is grounded in the codebase, and ends with the
open decisions, a risk register, and a review checklist.

design-01 is the spec; this packet is the review surface. Where the two
disagree, design-01 wins and this packet should be corrected.

Scope of what is under review: a *design*, not code. Nothing in
`scripts/strategy-gen/` or `config/strategy-gen/` exists yet. The review
question is "is this the right architecture to build," not "is this
implementation correct."

## 1. Executive summary

The platform already owns the expensive half of a strategy engine: the
falsification gauntlet that tests a strategy against the data
(`apps/backtester` -> held-out -> walk-forward ->
`scripts/strategy-selection/qfa-611-strategy-selection.py`), with
deflated-Sharpe multiplicity control locked by ADR-0016. What is missing
is the *generation* layer; strategies are hand-authored, and the manual
search is visible in the `regime_shock_reversion_short` v2->v5 lineage.

The proposal adds a `generate -> test -> score -> refine` loop in front
of the existing gate. The central design claim is that generation is
cheap and the gate is the value, so the entire architecture is organized
around one invariant: **every candidate the loop scores must deflate the
gate's significance threshold, and the held-out archive must stay sealed
during search.** Without that, the loop is automated overfitting.

Recommended verdict to evaluate: **accept the architecture, build Tier 1
(parametric search) first, and promote to an ADR on acceptance** because
it touches alpha-promotion methodology (ADR-0016) and anti-tuning
governance (CF-30).

## 2. Provenance of the analysis

This design originated from two questions: (a) how to build a
quantifiable engine that generates and tests strategies against the
`D:\qfa-cache` data, and (b) whether an external "loop engineering" idea
(Horizon, horizon.trade) was usable here.

### 2a. What the data actually is

`D:\qfa-cache` is the local MNQ market-data lake, confirmed from code,
not assumption:

- `apps/strategy_runtime/src/data/parquet-cache.ts` `getDefaultCacheRoot()`
  returns `D:/qfa-cache/parquet` on win32 (overridable via
  `QFA_PARQUET_CACHE_ROOT`).
- `scripts/backtester/qfa-402b-mbp-trades-proxy-smoke.mts` references
  `D:/qfa-cache/databento/tier-a-feb-mar-2026` — the raw Databento DBN
  archive (MBO, MBP-10, trades) for the Feb-Apr 2026 window.

That feeds the DATA-04 microstructure feature surface
(`docs/data/DATA-04-MICROSTRUCTURE-FEATURES.md`), which is the real
signal vocabulary any generated strategy can draw on (spread, mid,
trade-aggressor imbalance as authoritative; OFI, microprice, queue
imbalance as subscope; `queue_position`/`absorption`/`sweep` blocked).

Reviewer note: this design assumes single-instrument MNQ, tick-to-minute,
trade-driven strategies. Anything needing cross-asset, options flow,
fundamentals, or true queue position is out of scope until new data
ingestion exists.

### 2b. The external idea (Horizon "loop engineering") and the verdict

The external thread argued for a closed loop scored on the information
coefficient (IC), its consistency (ICIR = mean(IC)/std(IC)), and a
signal half-life check (AR(1): t_half = -ln2/ln rho), gated on
out-of-sample data with attempt-count-aware thresholds.

Assessment used in this design:

- The *loop shape* is correct and is exactly the missing generation
  layer. Adopt it.
- The *out-of-sample gate + raise-the-bar-as-attempts-grow* insight is
  already implemented here, more rigorously: the Deflated Sharpe Ratio
  (`scripts/strategy-selection/_lib/psr_dsr.py`,
  `effective_trials.py`) is the formal version of "raise the bar." We
  are ahead of the thread on its headline point.
- IC/ICIR is **rejected as the objective.** IC is cross-sectional
  factor machinery (correlation of a factor across an asset universe
  vs forward returns). This platform is single-instrument MNQ
  time-series; there is no cross-section. The existing
  Sharpe/PF/expectancy objective is the right fit and scores the actual
  tradable object.
- Half-life is **demoted to a diagnostic**, useful as a live
  alpha-decay tripwire in paper/shadow, not as a generation gate.
- The Horizon *product* itself is out of scope: it is a closed-beta
  competitor, and "plain English -> live on exchange in minutes" is the
  opposite of this platform's deliberate gauntlet.

Net: borrow the loop, keep our scoring function, and recognize we
already own the hardest beat (the deflated gate).

## 3. Architecture under review

### 3.1 Data-split spine

```
D:\qfa-cache (DBN -> Parquet -> DATA-04 features)
  TRAIN        - generator searches; cheap scoring; iterate freely
  VALIDATION   - in-loop ranking + shortlisting (walk-forward folds)
  HELD-OUT     - SEALED. Touched once per candidate, by QFA-611 only.
  PAPER/SHADOW - live-forward, after the gate
```

The loop runs only in TRAIN+VALIDATION. Held-out leakage burns a
candidate. Enforced structurally by withholding the held-out path from
the generator.

### 3.2 The loop

`generate (1) -> test on TRAIN (2) -> score S on VALIDATION (3) ->
select + diagnose failures (4) -> refine back into generate (5)`, then
survivors go once through `QFA-611 on sealed HELD-OUT (6)` and, if they
advance, to paper -> shadow -> broker. Only steps 0-5 are new code; 6+
is the existing pipeline.

### 3.3 Two scoring functions (the key design choice)

A cheap in-loop score and a strict gate score, deliberately asymmetric.

In-loop `S` (validation, ranking only):

```
S = w_sharpe * HAC_Sharpe
  + w_pf     * log(min(profit_factor, cap))
  + w_exp    * expectancy_per_trade_R
  - w_dd     * max_drawdown_pct
  - w_disp   * fold_sharpe_dispersion     # consistency = the ICIR intuition
  - w_floor  * trade_count_softfloor
   (x hard-gate validity mask -> -inf if failed)
```

Gate (held-out, once per candidate): the unchanged QFA-611 verdict
(DSR/PSR deflated by `effective_trial_count`, HAC Sharpe floor, PF >=
1.35, >= 300 trades, drawdown headroom, per-regime >= 30 conditional,
sensitivity audit).

The asymmetry table:

| | in-loop S | QFA-611 gate |
|---|---|---|
| trade floor | soft (~120, pull to 300) | 300 hard |
| max drawdown | loose (~0.12-0.16) | 0.08 hard |
| significance | none, ranking only | DSR/PSR deflated by trials |
| frequency | thousands of times | once per survivor |

Rationale to scrutinize: optimizing directly on the strict gate would
push candidates to the gate boundary (overfitting to the gate). A
looser, cheaper S finds strong regions; the strict deflated gate culls
honestly. **Reviewer: this is the most important design choice to
challenge.**

## 4. Search-space schema and per-family flex

The schema (full form in design-01 section "Search-space schema") has
two load-bearing rules:

1. `step` is mandatory on every numeric dimension. A continuous space
   has infinite "trials" and cannot be deflated against infinity;
   quantization makes the trial count a real integer.
2. Constraint-invalid candidates are never backtested and never consume
   trial budget. You deflate only against candidates actually scored.

Three worked families demonstrate the schema flexing across shapes:

| | shock_reversion_short | trend_pullback | liquidity_sweep_reversal |
|---|---|---|---|
| gate style | regime thresholds (monotonic) | paired bands (non-degenerate) | - |
| targets | fixed RR | structure-anchored + RR fallback | - |
| modules | vix gate, delay, deadline exit | target-source, runner trail | - |
| scoring tilt | Sharpe + consistency | PF/expectancy/payoff; win-rate ignored | - |
| eligibility | eligible | eligible | **forbidden (CF-30)** |

- `regime_shock_reversion_short`: search dimensions are literally the
  manual v2->v5 deltas (per-regime shock thresholds, stop/RR geometry,
  confidence band; modules for vix over-fire gate, entry delay, shock
  persistence, session exclusion, deadline exit). Grounded in
  `config/strategies/regime_shock_reversion_short_v2..v5*.yaml`.
- `trend_pullback`: structurally different — band-gated entry
  (`z_ema9_min..max`, `pullback_ratio_min..max`) with non-degeneracy
  constraints, and structure-anchored targets
  (`choch_sell ?? nearest_resistance`, RR only as fallback per
  `apps/strategy_runtime/src/strategies/trend_pullback_long.ts`).
  Scoring tilts to a low-win-rate/high-payoff profile.
- `liquidity_sweep_reversal`: see section 5.

## 5. The governance finding (highest-signal item for review)

`config/strategies/liquidity_sweep_reversal_{long,short}.yaml` carry a
pre-committed retirement criterion: "DO NOT re-tune entry/exit/sizing
parameters to pass the gate" (CF-30), and the runtime enforces
`pre_committed_retirement === true`
(`liquidity_sweep_reversal_common.ts` `validateLiquiditySweepParameters`).

An automated parameter search over this family is therefore a direct
CF-30 violation — machine-scale re-tuning to pass the gate, the exact
"faster overfitting" the loop exists to prevent. The schema must carry a
first-class, enforced `generation_policy: eligible: false`, checked
before any sampling, so the loop refuses ineligible families instead of
quietly relaunching a retired strategy.

Reviewer takeaway: the schema's job is not only to describe what to
search but to encode what has been pre-committed *not* to search. Verify
that the eligibility gate is enforced before sampling, not after scoring.

## 6. Honesty invariants (must all hold)

1. `effective_trial_count` = every candidate ever *scored*, not just
   survivors.
2. Held-out is sealed across steps 1-5 (path withheld).
3. The gate runs once per candidate; a re-tuned candidate is a new trial
   and re-increments the budget.
4. Parameter lock before the gate (`parameter_lock.py`) so the gated
   artifact equals the deployed config.
5. Generation-policy eligibility checked before sampling.

## 7. Risk register

| # | Risk | Severity | Mitigation in design |
|---|---|---|---|
| R1 | Trial under-counting (scored candidates not deflated) | Critical | Invariant 1; budget is the search ceiling and flows to `effective_trial_count` |
| R2 | Held-out leakage during search | Critical | Invariant 2; structural path withholding |
| R3 | Re-gate-until-pass on a near-miss | High | Invariant 3; re-tune = new trial |
| R4 | CF-30 violation via auto-search of retired family | High | Section 5 eligibility gate, enforced pre-sampling |
| R5 | Loop overfits to the gate boundary | Medium | Two-score asymmetry (section 3.3) |
| R6 | In-loop S mis-weighted for a family's profile | Medium | Per-family scoring.yaml; trend example shows reweighting |
| R7 | Wrong objective imported (IC/ICIR) | Medium | Rejected in 2b; S uses Sharpe/PF/expectancy + dispersion |
| R8 | Search-space step too fine -> trial explosion | Low | Mandatory `step`; budget ceiling caps scored count |

## 8. Open decisions for the reviewer

1. **Two-score asymmetry**: accept the loose-explore / strict-gate split,
   or require a single objective? (Design recommends the split; this is
   the primary thing to challenge.)
2. **In-loop S weights**: are the starting weights and the
   `fold_sharpe_dispersion` penalty the right consistency proxy, or
   should a different stability metric be used?
3. **Sampler for Tier 1**: grid vs random vs GA vs Bayesian as the
   default. Design assumes GA with a fixed seed; grid may be preferable
   for auditability.
4. **Eligibility source of truth**: read `pre_committed_retirement` from
   the strategy config, a separate `generation_policy`, or both with a
   consistency check?
5. **ADR promotion**: confirm this should become an ADR on acceptance
   (it modifies alpha-promotion methodology and anti-tuning governance).

## 9. Review checklist

- [ ] Data scope (single-instrument MNQ, DATA-04 vocabulary) is correct
      and acceptable.
- [ ] The loop never reads held-out metrics in steps 1-5.
- [ ] `effective_trial_count` is fed by the count of *scored*
      candidates, not survivors.
- [ ] Numeric search dimensions all carry `step`; the space is finite.
- [ ] Constraint-invalid candidates do not consume trial budget.
- [ ] Eligibility (`generation_policy`/`pre_committed_retirement`) is
      enforced before sampling; `liquidity_sweep_reversal` is refused.
- [ ] The two-score asymmetry is justified and the gate is unchanged.
- [ ] In-loop S substitutes Sharpe/PF/expectancy + dispersion for
      IC/ICIR (no IC objective sneaks in).
- [ ] Half-life is a diagnostic, not a gate.
- [ ] Parameter lock precedes the gate.
- [ ] Tier sequencing (1 parametric -> 2 grammar/GP -> 3 ML deferred)
      is acceptable.

## 10. Relationship to existing ADRs

- ADR-0016 (QFA-611 alpha decision) is a binding input; the gate is
  reused unchanged. This design must not relax it.
- ADR-0010 (validation gate), ADR-0008 (walk-forward windows),
  ADR-0013/0014/0015 (regime substrate) are reused as-is.
- CF-30 anti-tuning discipline is binding; section 5 operationalizes it.
- On acceptance, a new ADR should lock: the two-score architecture, the
  trial-counting contract, and the generation-eligibility concept.

## 11. Source map (for verification)

- Cache location: `apps/strategy_runtime/src/data/parquet-cache.ts`;
  `scripts/backtester/qfa-402b-mbp-trades-proxy-smoke.mts`.
- Feature surface: `docs/data/DATA-04-MICROSTRUCTURE-FEATURES.md`.
- Gate driver + stats: `scripts/strategy-selection/qfa-611-strategy-selection.py`;
  `scripts/strategy-selection/_lib/{psr_dsr,hac_sharpe,effective_trials,parameter_lock,walk_forward_loader}.py`.
- Gate methodology: `docs/research/qfa-611-alpha-decision-research.md`;
  `docs/adr/ADR-0016-qfa-611-alpha-decision-criteria.md`.
- Family configs: `config/strategies/regime_shock_reversion_short_v2..v5*.yaml`,
  `trend_pullback_*.yaml`, `liquidity_sweep_reversal_*.yaml`.
- Family logic: `apps/strategy_runtime/src/strategies/`.
- Normative spec: `docs/research/strategy-generation-loop-design-01.md`.
</content>
