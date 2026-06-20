# Strategy-generation loop — design proposal (01)

## Status

Proposed (design-tier). Not a methodology lock. On acceptance this
becomes an ADR; the QFA-611 gate (ADR-0016) and CF-30 anti-tuning
discipline are binding inputs, not things this proposal may relax.

## Problem

The platform already owns the hard half of a strategy engine: the
falsification gauntlet that tests a strategy against the data
(`apps/backtester` -> held-out validation -> walk-forward ->
`scripts/strategy-selection/qfa-611-strategy-selection.py`). That
selection stage is best-in-class: HAC/Newey-West Sharpe, Deflated and
Probabilistic Sharpe Ratio deflated by an honest `effective_trial_count`,
stationary block bootstrap, per-regime stratification, and the
execution sensitivity audit (all derived in
`docs/research/qfa-611-alpha-decision-research.md`, locked by ADR-0016).

What is missing is the *generation* layer. Strategies are hand-authored
TS logic (`apps/strategy_runtime/src/strategies/`) plus YAML parameters
(`config/strategies/`). The manual search is visible in the
`regime_shock_reversion_short` lineage (v2 -> v3 -> v4_delay ->
v4_persist -> v5_strict_deadline -> v5_trail_at_deadline): each variant
added exactly one knob. That is strategy generation done by hand, and —
critically — each variant is a trial that should deflate the DSR
threshold.

This proposal specifies a generate -> test -> score -> refine loop that
automates the front end while feeding the existing deflated gate without
weakening its anti-overfitting guarantees.

## Non-negotiable framing

Generation is the easy part. The platform's value is the gate. The
single most important property of this design is that **every candidate
the loop evaluates must count toward `effective_trial_count`**, and the
held-out archive must stay sealed during search. Otherwise the loop is
"prettier noise faster" — the exact data-snooping failure (White's
Reality Check; Bailey-Lopez de Prado DSR) that ADR-0010 through ADR-0016
were built to prevent. The Deflated Sharpe Ratio is the formal version
of "raise the bar as your attempt count grows": the loop supplies the
attempt count; `psr_dsr.py` supplies the math.

## Data-split spine

The data is partitioned once, up front, and the partitions are absolute:

```
D:\qfa-cache (MNQ DBN -> Parquet cache -> DATA-04 features)
  TRAIN        - generator searches; cheap scoring; iterate freely
  VALIDATION   - in-loop ranking + shortlisting (walk-forward folds)
  HELD-OUT     - SEALED. Touched once per candidate, by QFA-611 only.
  PAPER/SHADOW - live-forward, after the gate
```

The loop spins only inside TRAIN+VALIDATION. The moment a candidate's
parameters are influenced by a held-out result, that candidate is burned.
Enforce structurally: the generator is never given a path to held-out
artifacts.

## The loop

```
(0) SEARCH SPACE SPEC      config/strategy-gen/<family>.search.yaml
        |
(1) GENERATE   sampler emits N candidate configs (grid->random->GA->bayes)
        |        out: config/strategies/_candidates/*.yaml
        |        trial_budget += N        <- honest counting starts here
(2) TEST       deterministic backtester on TRAIN (apps/backtester + WF)
        |        out: trade ledger per candidate
(3) SCORE      in-loop objective S on VALIDATION (reuse _lib stat code)
        |        + half-life diagnostic tag
(4) SELECT     keep top-k by S; bucket the rest by failure reason
        |  \
        |   (5) REFINE   feed reasons back: mutate around survivors,
        |   |            prune dead regions  ---> back to (1)
        |  /
(6) GATE       QFA-611 on SEALED held-out, ONCE per candidate
        |        effective_trial_count = trial_budget
        |        verdict in {ADVANCE_TO_PAPER, REJECT, RESEARCH_FURTHER}
        v
       PAPER (45-60 trading days) -> SHADOW -> broker
       (alpha-decay / half-life monitored live)
```

Only steps 0-5 are new code (a `scripts/strategy-gen/` front end). Steps
6+ are the pipeline already run by hand for every variant.

## Two scoring functions, not one

Unlike a single ICIR objective, this design uses a cheap in-loop score
and a strict gate score, deliberately asymmetric.

### In-loop score S (cheap, validation folds, ranking only)

```
S = w_sharpe   * HAC_Sharpe(val)
  + w_pf       * log(min(profit_factor, cap))
  + w_exp      * expectancy_per_trade_R
  - w_dd       * max_drawdown_pct
  - w_disp     * fold_sharpe_dispersion      # consistency = the ICIR intuition
  - w_floor    * trade_count_softfloor
   (x hard-gate validity mask -> -inf if failed)
```

S replaces IC/ICIR. IC/ICIR is cross-sectional factor machinery (corr of
a factor across a universe vs forward returns); this platform is
single-instrument MNQ, time-series, trade-driven. S scores the actual
tradable object (entries/exits/PnL), which is strictly more meaningful
here. The `fold_sharpe_dispersion` penalty is the time-series expression
of ICIR's "consistency beats one flashy reading."

### Gate score (strict, held-out, once)

Unchanged QFA-611 verdict: DSR/PSR thresholds, HAC Sharpe floor, profit
factor >= 1.35, >= 300 trades, drawdown headroom below the 10% live
kill-switch, per-regime >= 30 (conditional on >=10% contribution),
sensitivity-audit clean.

### The asymmetry is intentional

| | in-loop S (validation) | QFA-611 gate (held-out) |
|---|---|---|
| trade floor | soft (e.g. 120, pull to 300) | 300 hard |
| max drawdown | loose (e.g. 0.12-0.16) | 0.08 hard |
| significance | none, ranking only | DSR/PSR deflated by trial count |
| frequency | thousands of times | once per survivor |

If the loop optimized directly on the strict gate, it would push
candidates to sit exactly on the gate boundary — overfitting to the gate.
A looser, cheaper S finds genuinely strong regions; the strict deflated
gate then culls honestly.

## Search-space schema

`config/strategy-gen/_schema.md`, instantiated per family:

```yaml
schema_version: 1
family: <string>
base_config: <path>                 # locked config the space centers on
strategy_id_template: <string>      # e.g. "<family>_gen_{hash8}"

# checked FIRST, before any sampling
generation_policy:
  eligible: true | false
  reason: <string>                  # required when eligible: false
  required_to_revisit: <string>     # the only sanctioned path back in

parameters:
  <name>:
    type: float | int | categorical | bool
    range: [min, max]               # numeric
    step:  <grid quantum>           # REQUIRED: finite space => countable trials
    scale: linear | log
    default: <base value>           # anchors local search
    choices: [...]                  # categorical / discrete

modules:                            # optional structural toggles (the v4/v5 shape)
  <name>:
    enabled: { type: bool, choices: [true, false] }
    parameters: { ... }             # only sampled when enabled=true

constraints:                        # invalid != a trial; never backtested
  - "<expr over params>"

search:
  sampler: grid | random | ga | bayesian
  budget: <max candidates ever scored>   # the honest trial ceiling
  seed: <int>
  rounds: <int>
  keep_top_k: <int>
```

Two load-bearing schema rules: `step` is mandatory (a continuous space
has infinite "trials" and cannot be deflated against infinity;
quantization makes the trial count a real integer), and
constraint-invalid candidates do not consume trial budget (you only
deflate against candidates actually scored).

## Per-family instances

The schema holds its shape while content varies substantially across
strategy shapes. Three worked cases follow.

### regime_shock_reversion_short (regime-thresholded mean reversion)

Search dimensions are literally the manual v2->v5 deltas: shock z-score
thresholds per regime, stop/RR geometry, confidence band; plus optional
modules for the VIX over-fire gate (v3), entry-confirmation delay
(v4_delay), shock persistence (v4_persist), session-time exclusion
(v2_utc_16_18_exclusion), and deadline exit mode (v5). Constraints
enforce regime monotonicity (`low_shock_threshold_* >
high_shock_threshold_*`), an ordered RR ladder, and an ordered
confidence band. Scoring: HAC-Sharpe-anchored S with the fold-dispersion
consistency penalty; in-loop trade floor 120 (soft pull to 300), DD
tolerance 0.12.

### trend_pullback (band-gated trend continuation)

Structurally different in three ways, each changing the space:

1. Band-gated, not threshold-gated: entry needs trend strength inside a
   window (`z_ema9_min..max`) AND retracement inside a window
   (`pullback_ratio_min..max`). Search paired bounds with
   non-degeneracy constraints (`z_ema9_max - z_ema9_min >= 0.40`,
   `pullback_ratio_max - pullback_ratio_min >= 0.15`).
2. Structure-anchored targets: per the TS, target_1 is
   `choch_sell ?? nearest_resistance`, RR only as fallback. So search
   the fallback RR ladder and a `target_source_policy` module
   (structure_first vs rr_only), not "the target."
3. No regime/VIX/deadline machinery; a `runner_trail` module instead.

Scoring shifts to match a low-win-rate / high-payoff profile
(`default_target_2_rr: 4` vs the shock family's `2.0`): heavier weight on
profit factor and expectancy, a new `payoff_ratio = log(avg_win/avg_loss)`
term, win rate explicitly zero-weighted (it is supposed to be < 50%), DD
tolerance raised to ~0.16 (the long RR ladder makes equity lumpier), and
the consistency penalty raised (trend strategies cluster wins).

### liquidity_sweep_reversal (generation-INELIGIBLE)

This family carries a pre-committed retirement criterion in its config
("DO NOT re-tune entry/exit/sizing parameters to pass the gate", CF-30),
and the engine enforces it (`validateLiquiditySweepParameters` throws
unless `pre_committed_retirement === true`). An automated parameter
search over this family would be a direct CF-30 violation — re-tuning to
pass the gate, at machine scale; precisely the "faster overfitting"
failure the loop exists to prevent.

Therefore the generator's first step, before sampling, reads the family's
`generation_policy` / `pre_committed_retirement` and refuses:

```yaml
generation_policy:
  eligible: false
  reason: "pre_committed_retirement=true; CF-30 forbids in-family re-tuning"
  required_to_revisit: "research-tier ticket with explicit hypothesis
    redesign (NOT parameter search)"
```

For some families the correct search space is the empty set, by
governance. This must be a first-class, enforced concept; otherwise the
loop quietly launders a retired strategy back to life.

### How the schema flexes

| | shock_reversion_short | trend_pullback | liquidity_sweep_reversal |
|---|---|---|---|
| gate style | regime thresholds (monotonic) | paired bands (non-degenerate) | - |
| targets | fixed RR | structure-anchored + RR fallback | - |
| key modules | vix gate, delay, deadline exit | target-source, runner trail | - |
| scoring tilt | Sharpe-anchored + consistency | PF/expectancy/payoff; win-rate ignored | - |
| eligibility | eligible | eligible | forbidden (CF-30) |

The schema describes not only what to search but what has been
pre-committed *not* to search.

## Honesty invariants

1. `effective_trial_count` = every candidate ever *scored*, not just
   survivors. A GA that evaluates `budget` genomes deflates as if
   `budget` trials happened.
2. Held-out is sealed: steps 1-5 never read held-out metrics; enforce by
   withholding the path.
3. The gate runs once per candidate. A re-tuned candidate is a new trial
   and re-increments the budget. No "it just missed, let me tweak and
   re-gate."
4. Parameter lock before the gate (`parameter_lock.py`), so the gated
   artifact provably equals the deployed config.
5. Generation-policy eligibility is checked before sampling; ineligible
   families are refused and logged.

## Proposed implementation surface

- `config/strategy-gen/_schema.md` — the schema above.
- `config/strategy-gen/<family>.search.yaml` and
  `<family>.scoring.yaml` — per-family instances.
- `scripts/strategy-gen/` — sampler + candidate emitter + in-loop scorer,
  reusing `apps/backtester` and `scripts/strategy-selection/_lib`.
- Candidates emitted to `config/strategies/_candidates/`, registered as
  `CANDIDATE_STRATEGY_IDS`, locked, then handed to the existing QFA-611
  driver unchanged.

Tier sequencing: Tier 1 parametric search first (highest value, lowest
new code); Tier 2 grammar/GP synthesis next; Tier 3 ML signal models
deferred (DATA-04 guardrails currently block ML dataset generation, and
overfit risk is highest there).

## References

- ADR-0010 validation gate; ADR-0016 QFA-611 alpha decision criteria.
- `docs/research/qfa-611-alpha-decision-research.md` (DSR/PSR, HAC,
  block bootstrap, sensitivity audit derivations).
- CF-30 anti-tuning discipline; pre-committed retirement criteria in
  `config/strategies/liquidity_sweep_reversal_*.yaml`.
- `scripts/strategy-selection/qfa-611-strategy-selection.py` and
  `scripts/strategy-selection/_lib/` (psr_dsr, hac_sharpe,
  effective_trials, parameter_lock, walk_forward_loader).
- DATA-04 microstructure feature surface
  (`docs/data/DATA-04-MICROSTRUCTURE-FEATURES.md`).
</content>
</invoke>
